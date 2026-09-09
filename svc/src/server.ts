// The HTTP surface. node:http rather than Bun.serve so the package runs under
// either runtime (spec S4), and a hand-rolled router rather than a framework
// because the whole service is a dozen endpoints and a dependency that can
// reach the treasury is a dependency worth not having.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { formatEther, isAddress, getAddress } from 'viem';
import { VEEBuxAbi } from './abi.ts';
import type { Chain } from './chain.ts';
import { asChainError } from './chain.ts';
import { assertMayRead, authenticate, requirePlatform, type Principal } from './auth.ts';
import type { Config } from './config.ts';
import { HttpError, errorBody, toHttpError } from './errors.ts';
import type { Resolver } from './resolver.ts';
import type { Spawner } from './spawn.ts';
import type { Store } from './store.ts';
import type { Treasury } from './treasury.ts';
import { assertCanonicalAgentId, assertLookupName, formatVee } from './validate.ts';

export interface Services {
  config: Config;
  chain: Chain;
  resolver: Resolver;
  store: Store;
  spawner: Spawner;
  treasury: Treasury;
}

/// Bodies are small JSON objects. The cap is here so a caller cannot make this
/// process hold an unbounded buffer - it holds every wallet key in the game and
/// is not a place to discover a memory limit.
const MAX_BODY_BYTES = 64 * 1024;

type Handler = (ctx: RouteContext) => Promise<unknown>;

/// Which credential a route requires (spec S4 Authorisation).
///   platform - hub-core, facilitator, setup script. Mints and moves treasury.
///   wallet   - one agent's own credential; spends from itself only.
///   any      - either; a registry lookup reveals nothing a caller could not
///              learn by watching the chain.
type Scope = 'platform' | 'wallet' | 'any';

interface RouteContext {
  services: Services;
  /// Path parameter, already percent-decoded. Canonical ids contain a colon,
  /// which is legal in a path segment but arrives encoded from most clients.
  param: string;
  url: URL;
  /// Parsed JSON body, {} for a request that carried none.
  body: Record<string, unknown>;
  principal: Principal;
  /// The X-Wallet-Client header, if the caller sent one. See postSignTransfer.
  clientMarker: string | undefined;
}

export interface Route {
  method: string;
  /// Either an exact path, or a prefix ending in '/' that captures one segment.
  path: string;
  prefix: boolean;
  handler: Handler;
  scope: Scope;
  /// For routes shaped /prefix/<param>/suffix, e.g. /wallets/<id>/rotate.
  suffix?: string;
}

// --- handlers ------------------------------------------------------------
// Named functions, referenced directly in the table below, so the call graph
// stays legible rather than hiding behind string lookups.

async function getSupply({ services, principal }: RouteContext): Promise<unknown> {
  requirePlatform(principal, 'GET /supply');
  const { chain } = services;
  try {
    const [total, treasury] = (await Promise.all([
      chain.publicClient.readContract({
        address: chain.deployment.VEEBux,
        abi: VEEBuxAbi,
        functionName: 'totalSupply',
      }),
      chain.publicClient.readContract({
        address: chain.deployment.VEEBux,
        abi: VEEBuxAbi,
        functionName: 'balanceOf',
        args: [chain.treasury],
      }),
    ])) as [bigint, bigint];

    return { total: formatVee(total), treasury: formatVee(treasury), inPlay: formatVee(total - treasury) };
  } catch (err) {
    throw asChainError(err);
  }
}

async function getResolve({ services, param }: RouteContext): Promise<unknown> {
  const name = assertLookupName(param);
  const found = await services.resolver.require(name);
  return { address: found.address, canonical: found.canonical };
}

async function getReverse({ services, param }: RouteContext): Promise<unknown> {
  if (!isAddress(param)) throw new HttpError('invalid_request', 'not an address');
  const address = getAddress(param);

  const canonical = await services.resolver.reverseOf(address);
  if (!canonical) throw new HttpError('unknown_name', `no registry entry for ${address}`);
  return { canonical, aliases: await services.resolver.aliasesOf(address) };
}

/// Reconciliation for `409 intent_unresolved` (spec S4 "Intents"). Answered
/// from the store plus a chain lookup, so a caller can find out what actually
/// happened WITHOUT re-sending - which is the whole point: the alternative is a
/// caller guessing, and the wrong guess is a double charge.
///
///   reserved  - taken, no tx hash recorded. Either it never reached the wire
///               or it did and the answer was lost. The store cannot tell
///               these apart and neither can the chain, because nothing on
///               chain carries the intent id. A human reconciles this one.
///   broadcast - a hash exists; the chain has not confirmed it yet.
///   confirmed - the receipt says success.
///   failed    - the receipt says reverted. The money did NOT move.
async function getIntent({ services, param, principal }: RouteContext): Promise<unknown> {
  const intentId = decodeURIComponent(param ?? '');
  if (intentId === '') throw new HttpError('invalid_request', 'intent id is required');

  // "Self" is the principal behind the token, never anything the caller sent -
  // the same invariant /sign-transfer holds (ruled 02:03 UTC).
  //
  // ONE refusal for both "no such intent" and "not yours", with an IDENTICAL
  // body. Splitting them - a 404 here and a 403 for somebody else's - would
  // make the error an existence oracle: guess ids until one answers 403 and you
  // have confirmed another wallet's intent. This is why the ownership check
  // does not get to throw its own error.
  const record = services.store.intentRecord(intentId);
  const mine =
    record !== null && (principal.scope === 'platform' || principal.agentId === record.agentId);
  if (!mine) throw new HttpError('unknown_intent', `no intent ${intentId}`);

  // ANSWERED FROM THE STORE, not by a chain call. The tail already records
  // every IntentTransfer against the intent that authorised it, so the question
  // "did this land" has a local answer - and one that is stable rather than
  // dependent on an RPC succeeding at the moment a caller asks.
  //
  // `reserved` no longer means "unresolvable". It means the tail has not seen a
  // matching emission YET: either the transfer has not landed or the chain has
  // not been examined that far. The sweep is what turns that into `failed`, and
  // only when the cursor has passed the bound recorded at reservation.
  if (record.txHash) {
    return { intentId, status: 'confirmed', txHash: record.txHash };
  }

  const wallet = services.store.spawnedAddress(record.agentId);
  const ours =
    record.emissions > 0 &&
    record.firstFrom !== null &&
    wallet !== null &&
    record.firstFrom.toLowerCase() === wallet.toLowerCase();

  if (ours) {
    // Seen on chain, not yet swept into the row.
    return { intentId, status: 'broadcast', txHash: record.firstTx };
  }
  if (record.emissions > 0) {
    // An emission exists under this id but NOT from the reserving wallet.
    // transferWithIntent is permissionless, so this is somebody spending
    // against the intent rather than the intent resolving - reported rather
    // than counted as a resolution.
    return { intentId, status: 'reserved', foreignEmission: true };
  }
  return { intentId, status: 'reserved' };
}

async function getBalance({ services, param, principal }: RouteContext): Promise<unknown> {
  const name = assertLookupName(param);
  const found = await services.resolver.require(name);
  assertMayRead(principal, found.canonical);
  try {
    const [vee, eth] = await Promise.all([
      services.chain.publicClient.readContract({
        address: services.chain.deployment.VEEBux,
        abi: VEEBuxAbi,
        functionName: 'balanceOf',
        args: [found.address],
      }) as Promise<bigint>,
      services.chain.publicClient.getBalance({ address: found.address }),
    ]);
    return { vee: formatVee(vee), eth: formatEther(eth) };
  } catch (err) {
    throw asChainError(err);
  }
}

async function getHistory({ services, param, url, principal }: RouteContext): Promise<unknown> {
  assertMayRead(principal, (await services.resolver.require(assertLookupName(param))).canonical);
  const raw = url.searchParams.get('limit');
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new HttpError('invalid_request', 'limit must be an integer between 1 and 1000');
  }
  return services.treasury.history(param, limit);
}

async function postWallets({ services, body, principal }: RouteContext): Promise<unknown> {
  requirePlatform(principal, 'POST /wallets');
  return services.spawner.spawn(body);
}

/// Set a wallet's balance to exactly `vee` (arena spec S3). Platform scope: it
/// can move money OUT of an agent's wallet, which no other endpoint can, and
/// the containment is that its destination is the treasury and is not a
/// parameter. See Treasury.sweepToTreasury.
async function postBalance({ services, body, param, principal }: RouteContext): Promise<unknown> {
  requirePlatform(principal, 'POST /wallets/:agentId/balance');
  return services.treasury.setBalance(assertCanonicalAgentId(param), body);
}

/// Partial policy update, and the only way back from frozen. DELETE /wallets
/// still means retirement and stays irreversible.
async function patchPolicy({ services, body, param, principal }: RouteContext): Promise<unknown> {
  requirePlatform(principal, 'PATCH /wallets/:agentId/policy');
  return services.spawner.patchPolicy(assertCanonicalAgentId(param), body);
}

async function postAliases({ services, body, principal }: RouteContext): Promise<unknown> {
  requirePlatform(principal, 'POST /aliases');
  return services.spawner.addAlias(body);
}

async function postFund({ services, body, principal }: RouteContext): Promise<unknown> {
  requirePlatform(principal, 'POST /fund');
  return services.treasury.fund(body);
}

async function postSignTransfer({ services, body, principal, clientMarker }: RouteContext): Promise<unknown> {
  return services.treasury.signTransfer(principal, body, clientMarker);
}

async function deleteWallet({ services, param, principal }: RouteContext): Promise<unknown> {
  requirePlatform(principal, 'DELETE /wallets');
  return services.spawner.retire(assertCanonicalAgentId(param));
}

async function postRotate({ services, param, principal }: RouteContext): Promise<unknown> {
  requirePlatform(principal, 'POST /wallets/:agentId/rotate');
  return services.spawner.rotateToken(param);
}

async function postStage({ services, body, principal }: RouteContext): Promise<unknown> {
  requirePlatform(principal, 'POST /stage');
  const stage = body.stage;
  if (typeof stage !== 'string' || stage.trim() === '') {
    throw new HttpError('invalid_request', 'stage must be a non-empty string');
  }
  services.store.setStage(stage.trim());
  return { stage: stage.trim() };
}

export const ROUTES: Route[] = [
  { method: 'GET', path: '/supply', prefix: false, scope: 'platform', handler: getSupply },
  { method: 'GET', path: '/resolve/', prefix: true, scope: 'any', handler: getResolve },
  { method: 'GET', path: '/reverse/', prefix: true, scope: 'any', handler: getReverse },
  // 'any' at the router, then self-only inside: the handler has to resolve the
  // name before it can know whose wallet it is.
  { method: 'GET', path: '/balance/', prefix: true, scope: 'any', handler: getBalance },
  { method: 'GET', path: '/history/', prefix: true, scope: 'any', handler: getHistory },
  { method: 'GET', path: '/intents/', prefix: true, scope: 'any', handler: getIntent },
  { method: 'POST', path: '/wallets', prefix: false, scope: 'platform', handler: postWallets },
  { method: 'POST', path: '/wallets/', prefix: true, suffix: '/rotate', scope: 'platform', handler: postRotate },
  { method: 'POST', path: '/wallets/', prefix: true, suffix: '/balance', scope: 'platform', handler: postBalance },
  { method: 'PATCH', path: '/wallets/', prefix: true, suffix: '/policy', scope: 'platform', handler: patchPolicy },
  { method: 'POST', path: '/aliases', prefix: false, scope: 'platform', handler: postAliases },
  { method: 'POST', path: '/fund', prefix: false, scope: 'platform', handler: postFund },
  { method: 'POST', path: '/stage', prefix: false, scope: 'platform', handler: postStage },
  { method: 'POST', path: '/sign-transfer', prefix: false, scope: 'wallet', handler: postSignTransfer },
  { method: 'DELETE', path: '/wallets/', prefix: true, scope: 'platform', handler: deleteWallet },
];

/// @throws HttpError for a malformed percent-escape - a caller error, not a
/// routing miss, so it must not fall through to "no route".
function match(method: string, pathname: string): { route: Route; param: string } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    if (!route.prefix) {
      if (pathname === route.path) return { route, param: '' };
      continue;
    }
    if (pathname.startsWith(route.path)) {
      let rest = pathname.slice(route.path.length);
      if (route.suffix) {
        if (!rest.endsWith(route.suffix)) continue;
        rest = rest.slice(0, -route.suffix.length);
      }
      if (rest.length === 0) continue;

      // Decode FIRST, then check for a separator. The check used to run on the
      // ENCODED path, so `%2F` passed it and became a slash afterwards - safe
      // only because every consumer re-validates the charset, which is a trap
      // for the next handler that trusts `param` to be one segment.
      //
      // A malformed escape is a CALLER error: unwrapped, decodeURIComponent
      // throws URIError, which reached the `internal_error` path and wrote to
      // the log line reserved for "this is a bug in chain-svc". Letting any
      // token holder write into that channel degrades the signal an operator
      // uses to find real ones.
      let param: string;
      try {
        param = decodeURIComponent(rest);
      } catch {
        throw new HttpError('invalid_request', 'malformed percent-encoding in the path');
      }
      // One segment only: /resolve/a/b is not a name with a slash in it.
      if (!param.includes('/')) return { route, param };
    }
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError('invalid_request', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError('invalid_request', 'body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError('invalid_request', 'body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/// The router-level scope check, kept as a named function so it can be tested
/// on its own.
///
/// It is deliberately REDUNDANT with the requirePlatform call inside each
/// platform handler, and that redundancy is why it needs its own test: with
/// both in place, deleting either leaves the end-to-end suite green (verified
/// by mutation). This one exists for the route somebody adds later and forgets
/// to guard - so it is tested here rather than through a route, because every
/// current route is also covered by its handler.
export function assertRouteScope(route: Route, principal: Principal, what: string): void {
  if (route.scope === 'platform' && principal.scope !== 'platform') {
    throw new HttpError('wrong_scope', `${what} requires the platform credential`);
  }
  if (route.scope === 'wallet' && principal.scope !== 'wallet') {
    throw new HttpError('wrong_scope', `${what} requires a wallet credential`);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

export async function handle(services: Services, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://chain-svc');
  try {
    // Unauthenticated on purpose: compose's healthcheck must not need the
    // token, and it reveals nothing a caller could not learn by connecting.
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }

    const principal = authenticate(req.headers.authorization, services.config.token, services.store);

    const found = match(req.method ?? 'GET', url.pathname);
    if (!found) throw new HttpError('invalid_request', `no route for ${req.method} ${url.pathname}`);

    assertRouteScope(found.route, principal, `${req.method} ${url.pathname}`);

    const method = req.method ?? 'GET';
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);

    const marker = req.headers['x-wallet-client'];
    const result = await found.route.handler({
      services,
      param: found.param,
      url,
      body,
      principal,
      clientMarker: Array.isArray(marker) ? marker[0] : marker,
    });
    return send(res, 200, result);
  } catch (err) {
    const httpError = toHttpError(err);
    if (httpError.code === 'internal_error') {
      // The detail may name a key file path or an RPC URL; log it, never ship it.
      console.error('chain-svc: unhandled error', err);
    }
    return send(res, httpError.status, errorBody(httpError));
  }
}

export function createChainSvcServer(services: Services): Server {
  return createServer((req, res) => {
    void handle(services, req, res);
  });
}
