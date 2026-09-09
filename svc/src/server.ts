// The HTTP surface. node:http rather than Bun.serve so the package runs under
// either runtime (spec S4), and a hand-rolled router rather than a framework
// because the whole service is a dozen endpoints and a dependency that can
// reach the treasury is a dependency worth not having.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { formatEther, isAddress, getAddress } from 'viem';
import { VEEBuxAbi } from './abi.ts';
import type { Chain } from './chain.ts';
import { asChainError } from './chain.ts';
import type { Config } from './config.ts';
import { assertAuthorized } from './config.ts';
import { HttpError, errorBody, toHttpError } from './errors.ts';
import type { Resolver } from './resolver.ts';
import type { Store } from './store.ts';
import { assertLookupName, formatVee } from './validate.ts';

export interface Services {
  config: Config;
  chain: Chain;
  resolver: Resolver;
  store: Store;
}

type Handler = (ctx: RouteContext) => Promise<unknown>;

interface RouteContext {
  services: Services;
  /// Path parameter, already percent-decoded. Canonical ids contain a colon,
  /// which is legal in a path segment but arrives encoded from most clients.
  param: string;
  url: URL;
}

interface Route {
  method: string;
  /// Either an exact path, or a prefix ending in '/' that captures one segment.
  path: string;
  prefix: boolean;
  handler: Handler;
}

// --- handlers ------------------------------------------------------------
// Named functions, referenced directly in the table below, so the call graph
// stays legible rather than hiding behind string lookups.

async function getSupply({ services }: RouteContext): Promise<unknown> {
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

async function getBalance({ services, param }: RouteContext): Promise<unknown> {
  const name = assertLookupName(param);
  const found = await services.resolver.require(name);
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

export const ROUTES: Route[] = [
  { method: 'GET', path: '/supply', prefix: false, handler: getSupply },
  { method: 'GET', path: '/resolve/', prefix: true, handler: getResolve },
  { method: 'GET', path: '/reverse/', prefix: true, handler: getReverse },
  { method: 'GET', path: '/balance/', prefix: true, handler: getBalance },
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
      const rest = pathname.slice(route.path.length);
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

    assertAuthorized(req.headers.authorization, services.config.token);

    const found = match(req.method ?? 'GET', url.pathname);
    if (!found) throw new HttpError('invalid_request', `no route for ${req.method} ${url.pathname}`);

    const body = await found.route.handler({ services, param: found.param, url });
    return send(res, 200, body);
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
