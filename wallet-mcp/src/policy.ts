// The model-facing policy check (spec S5).
//
// AUTHORITY LIVES IN CHAIN-SVC, NOT HERE. This process runs inside a persona
// that is designed to be socially engineered, so every check below is a
// convenience: it gives the model a readable refusal without a round trip, and
// it owns `duplicate_intent`, which only this side can see. chain-svc enforces
// the same caps on /sign-transfer and wins any disagreement - the same rule as
// `frozen`. Do not "optimise" the server-side check away on the grounds that
// this one exists.

import { readFileSync } from 'node:fs';

/// The refusal strings a model reads (spec S5). They are part of the tool
/// contract, so they are stable and lowercase.
export type Refusal =
  | 'over_max_per_tx'
  /// §1b. The policy sets NO cap for this token, so no amount can be spent - as
  /// distinct from `over_max_per_tx`, where a smaller one could. A SPLIT, not an
  /// addition: `over_max_per_tx` keeps its other meaning.
  ///
  /// A CODE IS AN INSTRUCTION, not merely a description. The old code was
  /// defensible as a description - the per-transaction bound refusing, with the
  /// bound at zero because nobody set one - and wrong as an instruction: it
  /// tells a persona to try less when no amount can work.
  | 'no_cap_set'
  | 'over_stage_cap'
  | 'counterparty_denied'
  | 'unknown_name'
  /// A bare `to` that is BOTH a registered name and a peer in this wallet's own
  /// namespace (§5). A DISTINCT reason, not folded into `unknown_name`: the
  /// name resolved twice, not zero times, and telling a persona "no wallet is
  /// registered as toby" when two are would send it looking for the wrong
  /// thing. Refusing rather than guessing is what stops a vanity squat
  /// redirecting in-namespace payments.
  | 'ambiguous_name'
  | 'duplicate_intent'
  // Not a policy refusal: the send may have happened. Kept in this union
  // because it is a reason the model sees, and the model must be able to tell
  // it apart from every refusal that means "nothing moved".
  | 'intent_unresolved'
  /// The caller's own input was malformed - a name that cannot be a name, an
  /// amount that cannot be an amount. Persona-facing because it is a fact about
  /// what the persona just typed: it can already learn it by trying again, and
  /// telling it is the difference between a model that corrects itself and one
  /// that retries the same bad string against an opaque "error".
  | 'invalid_name'
  | 'invalid_amount'
  /// No contract with that key in this deployment. A fact about the PUBLIC
  /// registry, like `unknown_name`: the `contracts` tool lists exactly what
  /// exists, so refusing to say which keys are real would only make a persona
  /// guess at a menu it can already read.
  | 'unknown_contract'
  /// This wallet may not call that function on that contract. ONE REASON FOR
  /// BOTH CAUSES - no allowlist entry at all, and an entry that does not
  /// include this wallet's kind - deliberately: distinguishing them would tell
  /// a persona what OTHER kinds of wallet are permitted to do.
  | 'function_not_allowed'
  /// No token by that key or symbol in this deployment. A fact about the PUBLIC
  /// registry, like `unknown_contract` and `unknown_name`: a persona reads token
  /// SYMBOLS in every balance and every history entry, so refusing to say which
  /// ones exist would refuse it the vocabulary the service itself taught it.
  | 'unknown_token'
  /// The arguments did not match the function's ABI, with the index and the
  /// expected type. A fact about what the persona just typed, like
  /// `invalid_amount`, and the detail is what lets a model fix its own call
  /// instead of retrying the same one.
  | 'bad_args'
  /// The call was mined and the contract reverted. The persona must know its
  /// call did nothing, or it will assume success and act on it; the REASON is
  /// withheld, because a revert string is the contract's internal state and
  /// says more about the game's machinery than a player should read.
  | 'revert';

/// §1b. The one cap value that is not an amount, spelled once.
///
/// MIRRORS `UNLIMITED` in svc/src/policy.ts and must equal it character for
/// character. NOT IMPORTED from there: wallet-mcp's only reference to chain-svc
/// is `import type`, which is erased, so this package keeps ZERO RUNTIME
/// DEPENDENCY on chain-svc and still runs with it absent (org-core imports this
/// as a library). A value import would be the first one and would end that.
///
/// So this is the `matchesPattern` arrangement again - two spellings of one
/// constant, and a test in svc/test that they agree, because that suite may
/// import both. A fourth spelling anywhere would be an uncapped wallet that
/// looks capped.
export const UNLIMITED = 'unlimited';

/// BOTH FIELDS OPTIONAL as of v0.8.0, mirroring chain-svc. Absence is not a
/// hole to fail closed on - it is "nobody wrote a bound", and this layer must
/// answer what the boundary would answer or it is a divergence rather than a
/// pre-check.
export interface TokenCaps {
  max_per_tx?: number | string;
  max_per_stage?: number | string;
}

/// Is this a value a cap may take? EXACTLY `"unlimited"`, or an amount.
///
/// Mirrors chain-svc's `isCap`. The exact match is tested FIRST and never by a
/// broader predicate: `typeof v === 'string' && !isNumeric(v)` is the
/// implementation to reach for and the one to refuse, because it makes
/// `"unlimted"` an uncapped wallet and a typo is the likeliest way anyone ever
/// writes a non-numeric cap. Everything else stays invalid and reads as ABSENT,
/// which fails closed.
export function isCapAmount(value: unknown): boolean {
  if (value === UNLIMITED) return true;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  if (!/^\d+(\.\d+)?$/.test(value)) return false;
  return Number(value) > 0;
}

export interface WalletPolicy {
  agentId: string;
  /// KEYED BY TOKEN KEY, never by symbol - chain-svc writes this file and its
  /// own bookkeeping stores the key. `resolveTokenOrRefusal` is where a key and
  /// a symbol meet, once.
  ///
  /// EVERY FIELD OPTIONAL, and absence means no rule - see `capsRefusal`.
  caps?: Record<string, TokenCaps>;
  allow?: string[];
  deny?: string[];
}

/// Read fresh on every send rather than cached. It USED to be that retirement
/// rewrote this file with `frozen: true`, so a cached copy would keep spending
/// for as long as the process lived; at chain-svc v0.8.0 `retire()` writes only
/// its own table and never a policy file, and `frozen` left the document
/// entirely. The reason to re-read survives the reason that prompted it: this
/// file is chain-svc's to rewrite at any time (a platform PATCH, a clear), and
/// it is a FAST PATH over an authority that is checked again on every send.
export function readPolicy(path: string): WalletPolicy | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as WalletPolicy;
    // A file with no `caps` is the PRE-MULTI-TOKEN shape, and it is treated as
    // unreadable rather than migrated here. Two reasons, and the second is the
    // one that matters: chain-svc already migrates it in memory and rewrites it,
    // so a second migration in this package would be the same rule written
    // twice; and returning null defers to chain-svc, which is the authority,
    // instead of failing closed on every send until that rewrite happens. A
    // wallet frozen by its own fast path during an ordinary upgrade is the
    // failure this avoids. "I cannot read the rules" and "the rules say nothing
    // about this token" are different, and only the second refuses.
    const caps = (parsed as { caps?: unknown } | null)?.caps;
    if (caps && typeof caps === 'object' && Array.isArray(parsed?.allow)) return parsed;
  } catch {
    // Unreadable policy: see checkLocally - this is NOT treated as permission.
  }
  return null;
}

/// `*` matches anything, `*.{tld}` a suffix, `acme:*` a prefix; anything else is
/// a literal. THE SAME RESTRICTED DIALECT AS chain-svc, character for
/// character, on purpose: two glob implementations that disagree would produce
/// a local "allowed" and a server-side refusal, which reads to a model as the
/// platform being broken - and in the other direction a local "allowed" over a
/// pattern the boundary reads as a literal.
///
/// The trailing-star form was added with chain-svc's (ruled). If you
/// change one of these, change both; `svc/test/policy.test.ts` asserts
/// they agree across allow AND deny.
///
/// Validation of malformed patterns lives in chain-svc, which WRITES this file.
/// This side only reads it, and a reader that re-validated could refuse a
/// policy the boundary accepted - which is the disagreement above, wearing a
/// different hat.
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/// The local pre-check. Returns a refusal the model can read, or null to mean
/// "nothing local objects" - never "approved", because approval is chain-svc's.
///
/// The stage cap is deliberately NOT checked here: it counts spends since the
/// last stage change, and this process has no stage source - hub-core's
/// /session needs a platform credential, which by design never reaches the
/// agent side. So `over_stage_cap` arrives from chain-svc and is surfaced
/// verbatim. Flagged for the spec: adding a stage source here would mean
/// giving the persona something it currently cannot see.
/// `vee` arrives as a DECIMAL STRING and is compared in wei, not as a float.
/// Comparing `Number("12.5") > max_per_tx` would reintroduce, in the check
/// itself, exactly the imprecision the string type exists to avoid.
/// Returns the canonical decimal string, or null if this is not a usable
/// amount. Deliberately NOT a parse-to-number-and-back: that is the rounding
/// this exists to prevent. A string is validated by shape and passed through
/// untouched, so "12.50" reaches chain-svc as "12.50".
export function normaliseVee(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const t = raw.trim();
    // Digits, optional single decimal point, at least one digit either side of
    // it. No exponent, no sign, no separators - chain-svc's parseVee is the
    // authority on the value and this only has to refuse what it cannot carry.
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    if (Number(t) <= 0) return null;
    return t;
  }
  // An INTEGER number is exactly representable, so tolerating it rounds
  // nothing. A non-integer is refused rather than stringified: 0.1 + 0.2 is
  // where money goes wrong quietly.
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return String(raw);
  return null;
}

/// `decimals` is the default token's, read from chain-svc's /modules at startup -
/// not a hardcoded 18. Both amounts are scaled by the same figure, so the
/// comparison in `checkLocally` is exact whatever the token's precision.
export function veeToWei(vee: string, decimals: number): bigint {
  const [whole, frac = ''] = vee.split('.');
  return BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals));
}

/// The local mirror of chain-svc's `capsFor`, and the counterpart its agreement
/// test asserts against.
///
/// RETURNS rather than throws - chain-svc's throws an `HttpError` this package
/// cannot import at runtime - so the test normalises one against the other. The
/// sentence is built the same way on both sides so they cannot drift into
/// refusing for the same reason with different words.
///
/// A TOKEN WITH NO ENTRY CANNOT BE SPENT. Silence fails CLOSED: an absent cap
/// read as "no limit" is the one reading that costs money, and it is the reading
/// a careless caller reaches for first.
export function capsRefusal(
  policy: WalletPolicy,
  tokenKey: string,
): { reason: Refusal; detail: string } | null {
  const caps = policy.caps?.[tokenKey];
  // A VALUE THIS SIDE CANNOT READ IS TREATED AS ABSENT, not as unlimited and
  // not as a crash. A typo, the empty string, null: each fails closed here with
  // the same answer silence gets. The empty string is the one that used to be
  // worst - `veeToWei('')` returns 0, so `max_per_tx: ''` refused every spend as
  // a bare `over_max_per_tx`: a bricked wallet whose message said the amount was
  // too large.
  //
  // PER CAP, NOT PER FILE. Rejecting the whole policy for one bad entry would
  // lose the local pre-check for every OTHER token because one was mistyped -
  // which defers more to chain-svc than the mistake warrants.
  // THREE OUTCOMES PER FIELD, the same table chain-svc's `capsFor` implements:
  // absent -> unbounded, "unlimited" -> unbounded, a valid amount -> that
  // bound, anything else -> no_cap_set naming the field.
  //
  // The two must agree VALUE FOR VALUE, not merely in spirit: this side is a
  // fast-path copy of a check whose authority is chain-svc, and a local answer
  // that differed would send a persona a refusal the boundary would not give,
  // or let one through the boundary then refuses.
  if (!caps) return null;
  for (const field of ['max_per_tx', 'max_per_stage'] as const) {
    const value = caps[field];
    if (value !== undefined && !isCapAmount(value)) {
      return { reason: 'no_cap_set', detail: `${field} for ${tokenKey} is not a usable amount` };
    }
  }
  return null;
}

/// `token` arrives as ONE value, not as a key and a decimals read separately.
/// Key, symbol and decimals are three facts about one token: sourced apart they
/// can drift to different tokens while each looks right, and only one of the
/// three is checkable by a value assertion. Passing the resolved token makes a
/// mixed-source amount unrepresentable rather than merely tested for.
export function checkLocally(
  policy: WalletPolicy | null,
  to: string,
  amount: string,
  token: { key: string; decimals: number },
): { reason: Refusal; detail?: string } | null {
  // Unreadable, or a shape this version does not parse: let chain-svc decide
  // rather than guess either way. NOT the same as a readable policy that says
  // nothing about this token, which refuses below.
  if (!policy) return null;

  const capless = capsRefusal(policy, token.key);
  if (capless) return capless;
  // ABSENT ENTRY, ABSENT FIELD: no local refusal. `capsRefusal` has already
  // refused anything present-and-unreadable, so what remains is either a usable
  // bound or no bound at all.
  const caps = policy.caps?.[token.key] ?? {};

  // §1b. `"unlimited"` skips THIS bound and nothing else - the stage bound is
  // its own field and its own decision, and chain-svc is the authority on both
  // regardless. The spend is still recorded there; a skipped bound is not a
  // skipped audit.
  if (
    caps.max_per_tx !== undefined &&
    caps.max_per_tx !== UNLIMITED &&
    veeToWei(amount, token.decimals) > veeToWei(String(caps.max_per_tx), token.decimals)
  ) {
    return { reason: 'over_max_per_tx' };
  }
  // Deny beats allow. ABSENT `deny` denies nothing; ABSENT `allow` allows
  // everything; a WRITTEN `allow: []` allows nothing, which is the one place
  // absent and empty diverge and is the same divergence chain-svc keeps.
  if ((policy.deny ?? []).some((p) => matchesPattern(p, to))) return { reason: 'counterparty_denied' };
  if (policy.allow !== undefined && !policy.allow.some((p) => matchesPattern(p, to))) {
    return { reason: 'counterparty_denied' };
  }
  return null;
}
