// The chain-svc /modules reply, read once at startup (spec S5 / Chain Modules §5).
//
// wallet-mcp advertises tools by the modules a deployment actually has, and reads
// the default token's symbol and decimals from here rather than hardcoding a
// symbol or 18 places. The reply is fetched by the process and passed in; the
// Wallet library never fetches (the same contract `log` arrived under in #100).

import type { WalletConfig } from './config.ts';

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
