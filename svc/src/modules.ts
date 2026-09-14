import type { Address } from 'viem';
import type { Deployment } from './chain.ts';
import { HttpError } from './errors.ts';

/// The deployable modules, and the contract each one deploys.
///
/// ONE PLACE, and the Solidity side (`KIND_CONTRACT` in Deploy.s.sol) is the
/// other. They are two declarations of one fact and nothing but a test makes
/// them agree - which is why the manifest's `kind` is validated against this
/// map rather than against a list written beside it.
export const MODULES = {
  token: 'Token',
  names: 'NameRegistry',
} as const;

export type ModuleKind = keyof typeof MODULES;

export interface TokenModule {
  key: string;
  address: Address;
  /// Read FROM THE CHAIN at boot, not from local.json. A file that records a
  /// symbol can disagree with the contract; a contract cannot disagree with
  /// itself.
  symbol: string;
  decimals: number;
}

export interface NamesModule {
  address: Address;
  /// The suffix canonical names end in, without the dot. Deployment data
  /// rather than code: it was a literal `.vee` in the validators until the
  /// manifest carried it.
  tld: string;
}

export interface Modules {
  /// In manifest order, so `tokens[0]` is the default token - the one every
  /// money endpoint, message and wallet-mcp tool operates on. Empty on a
  /// deployment with no token module.
  tokens: TokenModule[];
  names?: NamesModule;
}

/// The default token, or a refusal naming the reason.
///
/// A FUNCTION RATHER THAN `modules.tokens[0]` AT EACH CALL SITE, and the
/// difference is what happens on a names-only deployment: the indexing form
/// yields `undefined` and fails later, somewhere else, as a property access on
/// undefined. This fails here, with a code the route layer already knows how to
/// turn into a 404 and a persona-safe refusal.
export function defaultToken(m: Modules): TokenModule {
  const t = m.tokens[0];
  if (!t) throw new HttpError('module_not_deployed', 'this deployment has no token module');
  return t;
}

export function requireNames(m: Modules): NamesModule {
  if (!m.names) throw new HttpError('module_not_deployed', 'this deployment has no names module');
  return m.names;
}

/// Builds the live view of a deployment: every token's symbol and decimals read
/// FROM THE CHAIN, in manifest order.
///
/// A SEAM RATHER THAN INLINE CODE IN THE ENTRYPOINT, for the reason this module
/// has already paid once elsewhere: a control that is correct and correctly fed
/// can still be dormant if the wiring hands it a constant, and the entrypoint is
/// the one place no test reaches. `read` is structural so a test can supply two
/// tokens without a chain.
///
/// IT FAILS CLOSED IN BOTH DIRECTIONS AND NEITHER IS INCIDENTAL:
///
///   - A token whose `symbol()`/`decimals()` cannot be read STOPS THE BOOT.
///     The permissive alternative - a default symbol, or dropping the instance -
///     would serve money endpoints against a contract nobody can describe.
///   - Two tokens reporting the SAME symbol stop the boot. The manifest forbids
///     it, but the manifest is a request and the chain is the answer: the
///     contract's symbol is what a persona sees in a refusal and in history, so
///     two instances sharing one is two different moneys with one name.
export async function buildModules(
  deployment: Deployment,
  read: (address: Address) => Promise<{ symbol: string; decimals: number }>,
): Promise<Modules> {
  const tokens: TokenModule[] = [];
  let names: NamesModule | undefined;

  for (const m of deployment.modules) {
    if (m.kind === 'token') {
      let meta: { symbol: string; decimals: number };
      try {
        meta = await read(m.address);
      } catch (err) {
        throw new Error(
          `chain-svc: token "${m.key}" at ${m.address}: symbol()/decimals() unreadable - ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const clash = tokens.find((t) => t.symbol === meta.symbol);
      if (clash) {
        throw new Error(
          `chain-svc: tokens "${clash.key}" and "${m.key}" both report symbol ${meta.symbol}`,
        );
      }
      tokens.push({ key: m.key as string, address: m.address, symbol: meta.symbol, decimals: meta.decimals });
    } else {
      names = { address: m.address, tld: m.tld as string };
    }
  }

  return { tokens, names };
}

/// The boot line's module summary: `token:vee(VEE, 18 dp)@0x…, names(.vee)@0x…`.
///
/// An operator reading one line at start-up should be able to answer "what is on
/// this chain, and which token is the default?" without a second command. The
/// default is first because the list is in manifest order and that is what makes
/// it the default.
export function describeModules(m: Modules): string {
  const parts = m.tokens.map((t) => `token:${t.key}(${t.symbol}, ${t.decimals} dp)@${t.address}`);
  if (m.names) parts.push(`names(.${m.names.tld})@${m.names.address}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}
