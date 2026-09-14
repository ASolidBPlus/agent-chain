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
  | 'frozen'
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

export interface TokenCaps {
  max_per_tx: number | string;
  max_per_stage: number | string;
}

export interface WalletPolicy {
  agentId: string;
  /// KEYED BY TOKEN KEY, never by symbol - chain-svc writes this file and its
  /// own bookkeeping stores the key. `resolveTokenOrRefusal` is where a key and
  /// a symbol meet, once.
  ///
  /// A TOKEN WITH NO ENTRY CANNOT BE SPENT: see `capsRefusal`.
  caps: Record<string, TokenCaps>;
  allow: string[];
  deny: string[];
  frozen: boolean;
}

/// Read fresh on every send rather than cached: chain-svc rewrites this file to
/// `frozen: true` when a wallet is retired, and a cached copy would keep
/// spending for as long as the process lived.
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
  if (!caps || caps.max_per_tx === undefined || caps.max_per_stage === undefined) {
    return { reason: 'over_max_per_tx', detail: `no cap set for ${tokenKey}` };
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
  if (policy.frozen) return { reason: 'frozen' };

  const capless = capsRefusal(policy, token.key);
  if (capless) return capless;
  const caps = policy.caps[token.key]!;

  if (veeToWei(amount, token.decimals) > veeToWei(String(caps.max_per_tx), token.decimals)) {
    return { reason: 'over_max_per_tx' };
  }
  // Deny beats allow, and an empty allow list denies everything.
  if (policy.deny.some((p) => matchesPattern(p, to))) return { reason: 'counterparty_denied' };
  if (!policy.allow.some((p) => matchesPattern(p, to))) return { reason: 'counterparty_denied' };
  return null;
}
