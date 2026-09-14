// Server-side enforcement of a wallet's spending policy (spec S5, ruled).
//
// wallet-mcp keeps its own copy of these checks as the model-facing fast path -
// it produces the readable refusal the persona sees - but the AUTHORITY is
// here, for the same reason `frozen` is: wallet-mcp runs inside a persona that
// is designed to be socially engineered, so a check that lives only there is a
// convenience, not a boundary. A compromised persona bypasses it by calling
// chain-svc directly, which is exactly what was demonstrated before this file.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './errors.ts';
import { keyFileName } from './validate.ts';

/// THE ONE PLACE THE WALLET KINDS ARE LISTED.
///
/// It used to be four: this union, the array `loadPolicyDefaults` iterates, the
/// three-way equality in `Spawner.parseKind`, and the PROSE of parseKind's
/// rejection message. Adding a kind meant finding all four, and the fourth is
/// prose - so the natural failure was a validator that accepted the new kind
/// beside a message still telling callers it was invalid. A message that
/// disagrees with the condition it explains is worse than no message: it sends
/// the caller to fix input that was already correct.
///
/// Everything downstream derives from this array, including the message, so a
/// kind is added in ONE edit and the code cannot disagree with itself about
/// what it accepts.
export const WALLET_KINDS = ['org', 'agent', 'burner'] as const;

export type WalletKind = (typeof WALLET_KINDS)[number];

/// A type guard rather than an equality chain, so the CHECK and the LIST cannot
/// drift apart. Widening `unknown` here is deliberate: the caller has parsed
/// JSON and holds no type at all yet.
export function isWalletKind(value: unknown): value is WalletKind {
  return (WALLET_KINDS as readonly unknown[]).includes(value);
}

/// The caps written into an agent's policy file at spawn, which wallet-mcp
/// enforces (spec S5).
/// A cap, as a whole-VEE amount. NUMBER OR DECIMAL STRING, because a cap IS an
/// amount and every other amount on these wires is a decimal string (ruled
/// ruled). A number is accepted for the same reason it is on `vee`: an integer
/// is exactly representable, and a config author writes 25 as readily as "25".
///
/// Never compared as a float. `Number("12.5") > max_per_tx` would reintroduce,
/// inside the check, the imprecision the string form exists to prevent - see
/// veeToWei.
export type VeeCap = number | string;

export interface AgentPolicy {
  max_per_tx: VeeCap;
  max_per_stage: VeeCap;
  allow: string[];
  deny: string[];
}

export type PolicyDefaults = Record<WalletKind, AgentPolicy>;

/// Loaded from policy-defaults.json rather than held as a constant here, so the
/// numbers are game balance the owner tunes and not something a builder chose
/// (ruled). Read once at startup and FAILS LOUDLY if missing or
/// malformed: a wallet spawned with no caps is an unbounded wallet, so this
/// must not fall back to something permissive.
/// Patterns in the defaults file are written with a `{tld}` placeholder
/// (`*.{tld}`, `treasury.{tld}`) because the suffix is DEPLOYMENT DATA now, not
/// a constant: a deployment declares its TLD in the manifest and the same
/// defaults file has to serve all of them.
///
/// Without a names module the placeholder cannot be filled, and a pattern with
/// no TLD can match nothing - so those entries are DROPPED at load rather than
/// kept as literals containing `{tld}`, which would be a rule that silently
/// matches nothing while reading as if it matches something.
///
/// Logged ONCE PER DISTINCT PATTERN PER PROCESS, not per agent and not per
/// send: on a names-less deployment every agent without its own policy file
/// inherits these, so a per-agent key would print the same fact once per
/// wallet, and `policyFor` re-reads the file on every send by design. Once per
/// process is the signal; once ever would need a store row, and a config
/// oddity does not earn one.
const TLD_PATTERN = /\{tld\}/;

/// EXPORTED so a test can clear it, and that is not a leak of internals - it is
/// the honest shape of "once per PROCESS". The property is about process state,
/// so a test asserting it has to own that state; leaving the set private made
/// the assertion depend on which other test file had already consumed the first
/// occurrence, which is a test that passes alone and fails in a suite.
export const droppedPatternsLogged = new Set<string>();

function fillPatterns(
  patterns: string[],
  tld: string | undefined,
  field: 'allow' | 'deny',
  warn: (message: string) => void,
): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    if (!TLD_PATTERN.test(pattern)) {
      out.push(pattern);
      continue;
    }
    if (tld === undefined) {
      if (!droppedPatternsLogged.has(pattern)) {
        droppedPatternsLogged.add(pattern);
        warn(
          `[chain-svc] policy default ${field} pattern ${JSON.stringify(pattern)} names a TLD and ` +
            `this deployment has no names module, so it is dropped: it could match nothing. ` +
            `Nothing here can be addressed by name, so the rule has nothing to say.`,
        );
      }
      continue;
    }
    out.push(pattern.replace(TLD_PATTERN, tld));
  }
  return out;
}

export function loadPolicyDefaults(
  path: string,
  tld: string | undefined,
  warn: (message: string) => void = console.warn,
): PolicyDefaults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`chain-svc: cannot read policy defaults at ${path}: ${(err as Error).message}`);
  }
  const out = {} as PolicyDefaults;
  for (const kind of WALLET_KINDS) {
    const entry = (parsed as Record<string, unknown>)?.[kind];
    if (!isPolicy(entry)) {
      throw new Error(`chain-svc: policy defaults at ${path} have no valid "${kind}" entry`);
    }
    out[kind] = {
      ...entry,
      allow: fillPatterns(entry.allow, tld, 'allow', warn),
      deny: fillPatterns(entry.deny, tld, 'deny', warn),
    };
  }
  return out;
}

/// A cap in wei, from either accepted form. One conversion for both, so a
/// number and its string spelling can never compare differently.
export function capToWei(cap: VeeCap, decimals: number): bigint {
  const text = typeof cap === 'number' ? String(cap) : cap;
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals));
}

/// Is this a usable cap? A positive integer, or a positive decimal string with
/// at most `decimals` places - the same shape `vee` takes on the wire.
///
/// `decimals` defaults to 18 for the SHAPE check alone, because a policy
/// document is validated at spawn and PATCH time on deployments that may have
/// no token at all. Without a token nothing can move, so a cap is stored as
/// given and never enforced; validating its shape against the commonest scale
/// is better than refusing to validate it, and better than inventing a scale
/// for a token that is not there.
export function isCap(value: unknown, decimals = 18): value is VeeCap {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(value)) return false;
  return capToWei(value, decimals) > 0n;
}

const isNameList = (a: unknown): a is string[] =>
  Array.isArray(a) && a.every((x) => typeof x === 'string' && x.length > 0);

/// A CALLER-SUPPLIED POLICY IS A PATCH OVER THE KIND DEFAULTS, not a complete
/// document. Every field is optional and an omitted one falls to the default
/// for the wallet's kind (spec S4.1: "caps may be omitted and fall to
/// chain-svc's agent defaults").
///
/// It used to demand all four, which produced an asymmetry nobody would design
/// on purpose and which broke the acme: sending NO policy succeeded and fell
/// to defaults, while sending a strictly MORE SPECIFIC one - `allow`/`deny`
/// with the caps left to the defaults, which is the harness's whole use - was
/// refused outright. Found by running the stack rather than
/// reading it.
export function mergePolicy(value: unknown, defaults: AgentPolicy): AgentPolicy {
  if (value === undefined || value === null) return defaults;
  if (typeof value !== 'object') {
    throw new HttpError('invalid_request', 'policy must be an object');
  }
  const p = value as Record<string, unknown>;

  for (const field of ['max_per_tx', 'max_per_stage'] as const) {
    if (p[field] !== undefined && !isCap(p[field])) {
      // invalid_amount, not invalid_request (ruled): a cap IS an amount,
      // and a caller that sent 25.5 has made an amount mistake, not a
      // malformed-request one. Same code `vee` gets for the same reason.
      throw new HttpError(
        'invalid_amount',
        `${field} must be a decimal string of whole units, e.g. "25"; an integer number is ` +
          `tolerated, a non-integer number is refused rather than rounded`,
      );
    }
  }
  for (const field of ['allow', 'deny'] as const) {
    if (p[field] !== undefined && !isNameList(p[field])) {
      throw new HttpError('invalid_request', `${field} must be an array of non-empty strings`);
    }
  }

  const merged: AgentPolicy = {
    max_per_tx: (p.max_per_tx as VeeCap) ?? defaults.max_per_tx,
    max_per_stage: (p.max_per_stage as VeeCap) ?? defaults.max_per_stage,
    allow: (p.allow as string[]) ?? defaults.allow,
    deny: (p.deny as string[]) ?? defaults.deny,
  };
  assertPatternsUsable(merged.allow, 'allow');
  assertPatternsUsable(merged.deny, 'deny');
  return merged;
}

/// Still used to validate a policy FILE read back from disk, where a complete
/// document is what was written.
export function isPolicy(value: unknown): value is AgentPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return isCap(p.max_per_tx) && isCap(p.max_per_stage) && isNameList(p.allow) && isNameList(p.deny);
}


/// The policy chain-svc enforces for an agent is the SAME file it writes for
/// wallet-mcp to read, so the boundary and the fast path cannot drift into
/// disagreeing about what the caps are.
export async function readPolicyFile(policyDir: string, agentId: string): Promise<AgentPolicy | null> {
  try {
    const raw = await readFile(join(policyDir, keyFileName(agentId)), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isPolicy(parsed) ? parsed : null;
  } catch {
    return null;
  }
}


/// The pattern dialect for allow and deny lists. THREE forms and no more:
///
///   `*`        matches anything
///   `*suffix`  matches any name ending `suffix`   (`*.vee`)
///   `prefix*`  matches any name starting `prefix` (`acme:*`)
///   anything else is a LITERAL, compared whole.
///
/// Still deliberately not a general glob: the patterns come from a game config,
/// and a regex dialect nobody has specified is a way to write an allow rule
/// that silently matches more than its author meant. The trailing-star form was
/// added (ruled) because `acme:*` was needed and, until then, matched
/// NOTHING - it fell through to the literal comparison, so it was compared as
/// the seven-character string `acme:*`. In an allow list that refuses
/// everything, which is loud; in a DENY list it denies nothing, which is not.
///
/// A star anywhere else (`a*b`, `**`, `a*b*c`) is REFUSED AT POLICY LOAD rather
/// than silently treated as a literal - see assertPatternsUsable. A pattern
/// that looks like a glob and behaves like a string is the failure this dialect
/// exists to avoid, and the old code had exactly one of them.
///
/// wallet-mcp carries an identical copy. They must agree: wallet-mcp's
/// local refusal is the model-facing fast path and chain-svc's is the boundary,
/// and a pattern that means different things in the two is the drift the shared
/// policy file was written to prevent. `test/policy.test.ts` asserts agreement
/// across both lists.
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/// Refuses a pattern whose star is in a position this dialect does not
/// implement, so it fails at load with a name rather than at match time by
/// quietly matching nothing. Called for both `allow` and `deny`: a malformed
/// entry in `deny` is the dangerous one, because it fails silently open.
export function assertPatternsUsable(patterns: string[], field: 'allow' | 'deny'): void {
  for (const p of patterns) {
    const stars = p.split('*').length - 1;
    const usable = p === '*' || (stars === 1 && (p.startsWith('*') || p.endsWith('*'))) || stars === 0;
    if (!usable) {
      throw new HttpError(
        'invalid_request',
        `${field} pattern ${JSON.stringify(p)} is not supported: a star is allowed only as the ` +
          `whole pattern, a leading star (*.vee), or a trailing star (acme:*)`,
      );
    }
  }
}

export function isDenied(policy: AgentPolicy, name: string): boolean {
  return policy.deny.some((p) => matchesPattern(p, name));
}

export function isAllowed(policy: AgentPolicy, name: string): boolean {
  return policy.allow.some((p) => matchesPattern(p, name));
}

/// Throws the S5 refusal that applies, in the order S5 lists them, so the
/// reason a persona sees is stable rather than dependent on check ordering.
///
/// `over_stage_cap` is NOT raised here - it belongs to the atomic reservation
/// in the store, because a cap tested separately from the record it guards is
/// a check-then-act that every concurrent caller passes.
/// The stage cap in wei. Deliberately NOT checked by enforcePolicy: the check
/// and the spend record have to be one atomic step, or concurrent sends all
/// read the same pre-spend total and all pass. See Store.reserveStageSpend.
export function stageCapWei(policy: AgentPolicy, decimals: number): bigint {
  return capToWei(policy.max_per_stage, decimals);
}

/// HOW THE DENY LIST IS MATCHED, and why it takes two passes.
///
/// A wallet holds MORE THAN ONE name by design - that is not an edge case, it
/// is what `POST /aliases` is for: `addAlias` calls
/// `registerFor(alias, wallet, wallet)`, so a vanity alias and the canonical
/// agent id resolve to the same address. Matching the deny list against the
/// string the caller typed therefore denied a NAME and not a WALLET. Measured
/// before the fix, with `deny: ["mark.vee"]` - "mark.vee" refused,
/// "orch:mark" ALLOWED, same wallet, no registrar write and no privilege.
///
/// This function closes it by NAME: deny matches the requested name OR the
/// canonical, so a deny naming the canonical cannot be dodged with an alias.
/// That is the ruled case and the common one, because `reverse[target]`
/// keeps the first-registered name as the canonical.
///
/// It CANNOT close a deny naming one alias while the caller uses another -
/// neither string matches the entry, and the canonical matches neither. That
/// case is closed by IDENTITY in `Treasury.assertNotDeniedByIdentity`, which
/// resolves each literal deny entry once and compares addresses. Both passes
/// exist because neither is sufficient: wildcards have no address to resolve,
/// and strings cannot see through an alias.
///
/// Guidance that follows from the residual: a deny entry should name a
/// CANONICAL id, never a vanity alias - an alias-named deny relies on the
/// identity pass, which fails open if the registry read fails.
export function enforcePolicy(args: {
  policy: AgentPolicy;
  to: string;
  /// The registry's primary name for the resolved address. Pass it: matching
  /// only `to` is the alias bypass this function used to have.
  canonical?: string;
  amount: bigint;
  /// The default token's scale and symbol. Passed rather than assumed: a cap
  /// is a decimal string in whole units, and comparing it to an amount needs
  /// the scale the amount was parsed at.
  decimals: number;
  symbol: string;
}): void {
  const { policy, to, canonical, amount, decimals, symbol } = args;
  const perTx = capToWei(policy.max_per_tx, decimals);

  // A LOWER BOUND, because the boundary must not depend on wallet-mcp's check.
  // `parseVee` accepts "0" - deliberately, it is a parser and zero is a valid
  // number - and wallet-mcp refuses `vee <= 0` for the model. But a direct
  // caller with a wallet token bypasses wallet-mcp entirely, and a zero-VEE
  // sign-transfer burns an intent id and emits a zero Transfer for nothing.
  // Harmless in itself; the reason to refuse it here is that the rule "the
  // policy layer is a courtesy, the boundary is the boundary" has to hold for
  // every check, not the ones that happened to be duplicated.
  if (amount <= 0n) {
    throw new HttpError('invalid_amount', 'vee must be greater than zero');
  }
  if (amount > perTx) {
    throw new HttpError('over_max_per_tx', `max_per_tx is ${policy.max_per_tx} ${symbol}`);
  }

  // BOTH NAMES, and the two lists use them differently ON PURPOSE (ruled).
  //
  // DENY matches EITHER, so it is strictly harder to evade: a wallet holds more
  // than one name by design - `addAlias` registers an alias against the same
  // address - so denying `treasury.vee` while `treasure.vee` resolved to the
  // same wallet was a refusal and an allowance for one counterparty.
  //
  // ALLOW also matches either, and NOT the canonical alone, which is what a
  // literal reading of "evaluate against the resolved principal" would give.
  // Measured: the default agent allow list is `["*.vee"]` and canonical ids look
  // like `orch:bob`, so canonical-only matching refuses EVERY send to EVERY
  // agent wallet. Widening deny is the safe direction; narrowing allow is not.
  const names = canonical && canonical !== to ? [to, canonical] : [to];
  const denied = names.some((n) => isDenied(policy, n));
  const allowed = names.some((n) => isAllowed(policy, n));

  if (denied || !allowed) {
    throw new HttpError('counterparty_denied', `${to} is not an allowed counterparty`);
  }
}
