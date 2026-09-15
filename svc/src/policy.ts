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

/// What one wallet may spend of ONE token.
export interface TokenCaps {
  max_per_tx: VeeCap;
  max_per_stage: VeeCap;
}

export interface AgentPolicy {
  /// KEYED BY TOKEN KEY, not by symbol: this is chain-svc's own bookkeeping,
  /// and `stage_spend` and `intents` store the key. A symbol is what a persona
  /// reads and writes; `resolveToken` is where the two meet, once.
  ///
  /// A TOKEN WITH NO ENTRY CANNOT BE SPENT. Silence fails closed in money
  /// policy - an absent cap read as "no limit" is the one reading that costs
  /// money, and it is the reading a careless caller reaches for first.
  caps: Record<string, TokenCaps>;
  allow: string[];
  deny: string[];
}

/// The caps for one token, or the refusal that says there are none.
///
/// `no_cap_set` rather than `over_max_per_tx` (§1b). The old code was
/// defensible as a DESCRIPTION - the per-transaction bound refusing, with the
/// bound at zero because nobody set one - and wrong as an INSTRUCTION: it tells
/// a persona a smaller amount would succeed, when no amount can. A code is the
/// closed set a model switches on, so it has to be actionable, not merely true.
///
/// The DETAIL is unchanged and says which token, because a persona holding two
/// currencies cannot otherwise tell which of its spends is impossible.
export function capsFor(policy: AgentPolicy, tokenKey: string): TokenCaps {
  const caps = policy.caps?.[tokenKey];
  if (!caps || caps.max_per_tx === undefined || caps.max_per_stage === undefined) {
    throw new HttpError('no_cap_set', `no cap set for ${tokenKey}`);
  }
  return caps;
}

export type PolicyDefaults = Record<WalletKind, AgentPolicy>;

/// The one wildcard the defaults file's `caps` may use. EXACTLY TWO KEY FORMS,
/// `*` and a deployed token key - a third would make this a pattern language,
/// and the one place this system already has one (allow/deny) is the one place
/// it has needed a rule about what a pattern matching nothing means.
const CAPS_WILDCARD = '*';

function isTokenCaps(value: unknown): value is TokenCaps {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return isCap(c.max_per_tx) && isCap(c.max_per_stage);
}

/// Turns the defaults file's `caps` into one entry per DEPLOYED token.
///
/// `*` is copied to every deployed key; an explicit key REPLACES the whole pair
/// for that token rather than merging into it, because field-by-field merging
/// is the trap: "au gets a bigger max_per_tx" would silently inherit the
/// wildcard's max_per_stage, and the wallet would carry two halves of one bound
/// taken from two different currencies.
///
/// SEPARATE FROM the `{tld}` substitution beside it rather than folded into it.
/// They answer different questions - which tokens a cap covers, and what a
/// pattern with no TLD can match - and the second has its own rule about a
/// pattern that matches nothing, which this one must not inherit.
function expandCaps(raw: unknown, tokenKeys: string[], kind: string, path: string): Record<string, TokenCaps> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`chain-svc: policy defaults at ${path}: "${kind}" has no caps object`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    // An empty caps map is a wallet that can spend nothing. That may be
    // deliberate for a kind, but it is not something to arrive at by leaving a
    // key out of a file, so it has to be written rather than defaulted into.
    throw new Error(`chain-svc: policy defaults at ${path}: "${kind}" sets no caps`);
  }

  const out: Record<string, TokenCaps> = {};
  let wildcard: TokenCaps | undefined;
  for (const [key, value] of entries) {
    if (!isTokenCaps(value)) {
      throw new Error(
        `chain-svc: policy defaults at ${path}: "${kind}" caps "${key}" is not ` +
          `{max_per_tx, max_per_stage} of usable amounts`,
      );
    }
    if (key === CAPS_WILDCARD) {
      wildcard = value;
      continue;
    }
    if (!tokenKeys.includes(key)) {
      // At LOAD, where the operator who wrote it is looking. A key naming a
      // token that is not deployed is a cap that will never be consulted, and
      // its author believes it will.
      throw new Error(
        `chain-svc: policy defaults at ${path}: "${kind}" caps names "${key}", not a deployed token`,
      );
    }
    out[key] = value;
  }

  if (wildcard) {
    for (const key of tokenKeys) {
      if (out[key] === undefined) out[key] = wildcard;
    }
  }
  return out;
}

/// Reads either policy shape and returns the current one.
///
/// The LEGACY shape - top-level `max_per_tx`/`max_per_stage` - becomes
/// `caps[<default token key>]`. A store full of v0.4.0 policy files is the
/// ordinary upgrade, and refusing them would freeze every wallet in a running
/// game; splitting them across tokens would invent a bound nobody wrote.
///
/// A file carrying BOTH shapes - written by a new binary, edited by hand from
/// an old example - keeps the NEW one: it is the shape that can express what
/// the old cannot, and preferring the legacy pair would discard every token but
/// the default.
export function normalisePolicy(value: unknown, defaultTokenKey: string | undefined): AgentPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError('invalid_request', 'policy must be an object');
  }
  const p = value as Record<string, unknown>;
  if (!isNameList(p.allow) || !isNameList(p.deny)) {
    throw new HttpError('invalid_request', 'policy must carry allow and deny lists');
  }

  if (p.caps !== undefined) {
    if (typeof p.caps !== 'object' || p.caps === null || Array.isArray(p.caps)) {
      throw new HttpError('invalid_request', 'caps must be an object keyed by token');
    }
    for (const [key, caps] of Object.entries(p.caps as Record<string, unknown>)) {
      if (!isTokenCaps(caps)) {
        throw new HttpError('invalid_request', `caps.${key} must be {max_per_tx, max_per_stage}`);
      }
    }
    return { caps: p.caps as Record<string, TokenCaps>, allow: p.allow, deny: p.deny };
  }

  if (isCap(p.max_per_tx) && isCap(p.max_per_stage)) {
    if (defaultTokenKey === undefined) {
      throw new HttpError(
        'invalid_request',
        'a legacy policy names no token and this deployment has none to read it against',
      );
    }
    return {
      caps: { [defaultTokenKey]: { max_per_tx: p.max_per_tx, max_per_stage: p.max_per_stage } },
      allow: p.allow,
      deny: p.deny,
    };
  }

  throw new HttpError('invalid_request', 'policy must carry caps, or max_per_tx and max_per_stage');
}

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
  /// The DEPLOYED token keys, in manifest order. Needed because `*` means
  /// "every token this deployment has", which the file cannot know and this
  /// function can - and because an explicit key naming a token that is not
  /// there is refused rather than kept as a cap nothing will consult.
  tokenKeys: string[],
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
    const entry = (parsed as Record<string, unknown>)?.[kind] as Record<string, unknown> | undefined;
    if (typeof entry !== 'object' || entry === null || !isNameList(entry.allow) || !isNameList(entry.deny)) {
      throw new Error(`chain-svc: policy defaults at ${path} have no valid "${kind}" entry`);
    }
    out[kind] = {
      caps: expandCaps(entry.caps, tokenKeys, kind, path),
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
  // §1b. EXACTLY `"unlimited"`, before the regex and never a broader test.
  //
  // The fail-open implementation is the one to reach for and the one to refuse:
  // `!isNumeric(v) -> no bound` makes `"unlimted"` an uncapped wallet, and a
  // typo in a policy file is the likeliest way anyone ever writes a
  // non-numeric cap. An exact match keeps the regex as the gate for every
  // other string, so an unrecognised value stays invalid and reads as ABSENT -
  // which fails closed, as `no_cap_set`.
  if (value === UNLIMITED) return true;
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(value)) return false;
  return capToWei(value, decimals) > 0n;
}

/// §1b. The one cap value that is not an amount. A named constant rather than a
/// string literal at each site: three files test for it, and a fourth spelling
/// of it would be an uncapped wallet that looks capped.
export const UNLIMITED = 'unlimited';

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
export function mergePolicy(
  value: unknown,
  defaults: AgentPolicy,
  /// The default token's KEY, for reading a caller's legacy `max_per_tx` pair.
  /// Optional because a deployment may have no token at all, in which case a
  /// legacy pair has nothing to be about and is refused rather than guessed at.
  defaultTokenKey?: string,
): AgentPolicy {
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

  // A SUPPLIED CAPS MAP IS TAKEN WHOLE, replacing the kind's. The same rule as
  // the defaults file's explicit key, one level up: a caps map is what THIS
  // wallet may spend, not an amendment to what its kind may - and merging would
  // let a caller widen one token by naming another.
  //
  // The LEGACY pair is still accepted from a caller and read against the
  // default token, leaving the other tokens' defaults in place: a caller
  // writing the old shape is saying something about the default token, not
  // about every token.
  let caps = defaults.caps;
  if (p.caps !== undefined) {
    if (typeof p.caps !== 'object' || p.caps === null || Array.isArray(p.caps)) {
      throw new HttpError('invalid_request', 'caps must be an object keyed by token');
    }
    for (const [key, value] of Object.entries(p.caps as Record<string, unknown>)) {
      if (!isTokenCaps(value)) {
        throw new HttpError('invalid_request', `caps.${key} must be {max_per_tx, max_per_stage}`);
      }
    }
    caps = p.caps as Record<string, TokenCaps>;
  } else if (p.max_per_tx !== undefined || p.max_per_stage !== undefined) {
    if (defaultTokenKey === undefined) {
      throw new HttpError(
        'invalid_request',
        'max_per_tx and max_per_stage name no token and this deployment has none to read them against',
      );
    }
    const existing = defaults.caps[defaultTokenKey];
    caps = {
      ...defaults.caps,
      [defaultTokenKey]: {
        max_per_tx: (p.max_per_tx as VeeCap) ?? existing?.max_per_tx,
        max_per_stage: (p.max_per_stage as VeeCap) ?? existing?.max_per_stage,
      },
    };
    if (!isTokenCaps(caps[defaultTokenKey])) {
      throw new HttpError('invalid_request', 'max_per_tx and max_per_stage must be usable amounts');
    }
  }

  const merged: AgentPolicy = {
    caps,
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
  if (!isNameList(p.allow) || !isNameList(p.deny)) return false;
  // EITHER SHAPE IS A VALID DOCUMENT ON DISK. A store full of v0.4.0 policy
  // files is the ordinary upgrade, and a predicate that recognised only the new
  // shape would make every one of them unreadable - which `readPolicyFile`
  // turns into "no policy", which falls back to the KIND DEFAULTS. A wallet
  // whose operator had narrowed its caps would silently get the wider ones.
  if (p.caps !== undefined) {
    if (typeof p.caps !== 'object' || p.caps === null || Array.isArray(p.caps)) return false;
    return Object.values(p.caps as Record<string, unknown>).every(isTokenCaps);
  }
  return isCap(p.max_per_tx) && isCap(p.max_per_stage);
}


/// The policy chain-svc enforces for an agent is the SAME file it writes for
/// wallet-mcp to read, so the boundary and the fast path cannot drift into
/// disagreeing about what the caps are.
export async function readPolicyFile(
  policyDir: string,
  agentId: string,
  /// The default token's key, for reading a LEGACY file. Optional: a
  /// deployment with no token has nothing for a legacy pair to be about, and a
  /// file in the new shape needs no default at all.
  defaultTokenKey?: string,
): Promise<AgentPolicy | null> {
  try {
    const raw = await readFile(join(policyDir, keyFileName(agentId)), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isPolicy(parsed)) return null;
    // MIGRATED IN MEMORY, NOT REWRITTEN HERE. A read is a read; the file is
    // rewritten in the new shape by the next `writePolicyFile`, which is a
    // write somebody asked for. Migrating on read would have every send
    // rewriting a file, and a read path that writes is a read path that can
    // fail for reasons the caller never asked about.
    return normalisePolicy(parsed, defaultTokenKey);
  } catch {
    // UNREADABLE IS NOT DENIED. Missing, corrupt, or caught mid-rewrite: this
    // defers to the caller's fallback rather than refusing, because a transient
    // read error must not freeze a wallet in a running game. That is the
    // opposite silence from an absent CAP, which does refuse - one is "we could
    // not read the rules", the other is "the rules say nothing about this
    // token", and only the second is a decision the file made.
    return null;
  }
}


/// The pattern dialect for allow and deny lists. THREE forms and no more:
///
///   `*`        matches anything
///   `*suffix`  matches any name ending `suffix`   (`*.play`)
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
          `whole pattern, a leading star (*.play), or a trailing star (acme:*)`,
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
export function stageCapWei(policy: AgentPolicy, tokenKey: string, decimals: number): bigint {
  // Through capsFor, so a token with no entry refuses HERE rather than
  // defaulting to an unbounded stage. The reservation would otherwise take a
  // hold against a cap nobody set.
  return capToWei(capsFor(policy, tokenKey).max_per_stage, decimals);
}

/// HOW THE DENY LIST IS MATCHED, and why it takes two passes.
///
/// A wallet holds MORE THAN ONE name by design - that is not an edge case, it
/// is what `POST /aliases` is for: `addAlias` calls
/// `registerFor(alias, wallet, wallet)`, so a vanity alias and the canonical
/// agent id resolve to the same address. Matching the deny list against the
/// string the caller typed therefore denied a NAME and not a WALLET. Measured
/// before the fix, with `deny: ["mark.play"]` - "mark.play" refused,
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
  /// WHICH TOKEN's caps to check against. The key, not the symbol: caps are
  /// keyed by the manifest's own name, and `resolveToken` is the one place a
  /// symbol becomes a key.
  tokenKey: string;
}): void {
  const { policy, to, canonical, amount, decimals, symbol, tokenKey } = args;
  // capsFor, not policy.max_per_tx: a wallet with no entry for this token
  // cannot spend it, and that refusal has to come from the same place every
  // other cap does.
  const caps = capsFor(policy, tokenKey);
  const perTx = capToWei(caps.max_per_tx, decimals);

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
    throw new HttpError('over_max_per_tx', `max_per_tx is ${caps.max_per_tx} ${symbol}`);
  }

  // BOTH NAMES, and the two lists use them differently ON PURPOSE (ruled).
  //
  // DENY matches EITHER, so it is strictly harder to evade: a wallet holds more
  // than one name by design - `addAlias` registers an alias against the same
  // address - so denying `treasury.play` while `treasure.play` resolved to the
  // same wallet was a refusal and an allowance for one counterparty.
  //
  // ALLOW also matches either, and NOT the canonical alone, which is what a
  // literal reading of "evaluate against the resolved principal" would give.
  // Measured: the default agent allow list is `["*.{tld}"]` and canonical ids look
  // like `orch:bob`, so canonical-only matching refuses EVERY send to EVERY
  // agent wallet. Widening deny is the safe direction; narrowing allow is not.
  const names = canonical && canonical !== to ? [to, canonical] : [to];
  const denied = names.some((n) => isDenied(policy, n));
  const allowed = names.some((n) => isAllowed(policy, n));

  if (denied || !allowed) {
    throw new HttpError('counterparty_denied', `${to} is not an allowed counterparty`);
  }
}
