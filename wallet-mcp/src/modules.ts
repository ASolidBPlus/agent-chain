// The chain-svc /modules reply, read once at startup (spec S5 / Chain Modules §5).
//
// wallet-mcp advertises tools by the modules a deployment actually has, and reads
// the default token's symbol and decimals from here rather than hardcoding a
// symbol or 18 places. The reply is fetched by the process and passed in; the
// Wallet library never fetches (the same contract `log` arrived under in #100).

import type { WalletConfig } from './config.ts';
import type { Refusal } from './policy.ts';

export interface TokenModule {
  key: string;
  address: string;
  symbol: string;
  decimals: number;
}

export interface NamesModule {
  address: string;
  tld: string;
}

/// The shape of GET /modules (Chain Modules §4.3). A `converter` field may also
/// be present, but wallet-mcp does not read it: nothing is callable through the
/// converter yet, so it is deliberately absent from this type.
export interface ModulesReply {
  schema: number;
  chainId: number;
  treasury: string;
  /// The key of the default token, or null on a deployment with no token module.
  defaultToken: string | null;
  tokens: TokenModule[];
  names: NamesModule | null;
}

/// The default token (the one every money tool operates on), or null when the
/// deployment has none.
export function defaultTokenOf(modules: ModulesReply): TokenModule | null {
  if (modules.defaultToken === null) return null;
  return modules.tokens.find((t) => t.key === modules.defaultToken) ?? null;
}

/// Reads /modules with the wallet credential. Unreachable or non-200 is fatal:
/// the server cannot decide which tools to advertise without it, so main() lets
/// this throw and exits non-zero - the same contract the harness's `required: true`
/// expects. Cache the result for the process lifetime; the module set does not
/// change under a running chain.
export async function fetchModules(config: WalletConfig): Promise<ModulesReply> {
  const url = `${config.chainSvcUrl}/modules`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${config.walletToken}` } });
  } catch (err) {
    throw new Error(
      `wallet-mcp: cannot read /modules from chain-svc: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status !== 200) {
    throw new Error(`wallet-mcp: cannot read /modules from chain-svc: HTTP ${res.status}`);
  }
  return (await res.json()) as ModulesReply;
}

/// Either the token a caller named, or the refusal to hand back.
///
/// RETURNS RATHER THAN THROWS, which is why this is not called `resolveToken`
/// like chain-svc's. That one throws `HttpError`, a chain-svc type wallet-mcp
/// cannot import at runtime (see the type-only import in wallet.ts), and
/// returning is this package's idiom for a refusal anyway. Two functions that
/// look identical and behave differently is the drift a distinct name prevents.
export type TokenResolution =
  | { ok: true; token: TokenModule }
  | { ok: false; reason: Refusal | 'error'; detail: string };

/// The ONE place a key and a symbol meet on this side. Key first, then symbol,
/// both case-insensitive; absent means the default token.
///
/// Mirrors `resolveToken` in svc/src/modules.ts rule for rule - the two are
/// checked against each other by the agreement test, the same arrangement
/// `matchesPattern` already has. If you find yourself turning a key into a
/// symbol anywhere else in this package, that is this seam duplicating.
export function resolveTokenOrRefusal(modules: ModulesReply, keyOrSymbol: unknown): TokenResolution {
  // The tokenless case answers FIRST and answers differently: "this deployment
  // has no token module" is its SHAPE and is withheld from personas, while "no
  // such token" is its REGISTRY and they may have it. One answer for both would
  // tell a persona on a names-only deployment that its own currency does not
  // exist.
  if (modules.tokens.length === 0) {
    return { ok: false, reason: 'error', detail: 'this deployment has no token module' };
  }
  if (keyOrSymbol === undefined || keyOrSymbol === null || keyOrSymbol === '') {
    const fallback = defaultTokenOf(modules);
    if (!fallback) return { ok: false, reason: 'error', detail: 'this deployment has no default token' };
    return { ok: true, token: fallback };
  }
  if (typeof keyOrSymbol !== 'string') {
    return { ok: false, reason: 'error', detail: 'token must be a string: a manifest key or a symbol' };
  }

  const wanted = keyOrSymbol.toLowerCase();
  // Lowering the KEY side is unreachable while a manifest key must match
  // `^[a-z][a-z0-9]{0,15}$`, and a mutant removing it survives - correctly, not
  // as a coverage gap, because the isolating test would need a mixed-case key
  // the manifest refuses. It stays so the day that shape widens this line does
  // not start answering `unknown_token` to a key the manifest accepted. The
  // SYMBOL side is not in that position: a symbol is whatever case the contract
  // chose, and its mutant dies against a fixture whose symbol is not its key in
  // upper case.
  const byKey = modules.tokens.find((t) => t.key.toLowerCase() === wanted);
  if (byKey) return { ok: true, token: byKey };
  const bySymbol = modules.tokens.find((t) => t.symbol.toLowerCase() === wanted);
  if (bySymbol) return { ok: true, token: bySymbol };

  // The detail LISTS what exists: the caller is a model, and a persona-facing
  // refusal earns its keep by letting it fix its own call.
  return {
    ok: false,
    reason: 'unknown_token',
    detail:
      `no token "${keyOrSymbol}" in this deployment; it has ` +
      modules.tokens.map((t) => `${t.key} (${t.symbol})`).join(', '),
  };
}
