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
  | 'frozen'
  | 'duplicate_intent'
  // Not a policy refusal: the send may have happened. Kept in this union
  // because it is a reason the model sees, and the model must be able to tell
  // it apart from every refusal that means "nothing moved".
  | 'intent_unresolved';

export interface WalletPolicy {
  agentId: string;
  max_per_tx: number;
  max_per_stage: number;
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
    if (typeof parsed?.max_per_tx === 'number' && Array.isArray(parsed.allow)) return parsed;
  } catch {
    // Unreadable policy: see checkLocally - this is NOT treated as permission.
  }
  return null;
}

/// `*` matches anything, `*.vee` matches a suffix. Same restricted dialect as
/// chain-svc, on purpose: two glob implementations that disagree would produce
/// a local "allowed" and a server-side refusal, which reads to a model as the
/// platform being broken.
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  return pattern === name;
}

/// The local pre-check. Returns a refusal the model can read, or null to mean
/// "nothing local objects" - never "approved", because approval is chain-svc's.
///
/// The stage cap is deliberately NOT checked here: it counts spends since the
/// last stage change, and this process has no stage source - hub-core's
/// /session needs a platform credential, which by design never reaches the
/// agent side. So `over_stage_cap` arrives from chain-svc and is surfaced
/// verbatim. Flagged to powerout-planner: adding a stage source here would mean
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

export function veeToWei(vee: string): bigint {
  const [whole, frac = ''] = vee.split('.');
  return BigInt(whole + frac.padEnd(18, '0').slice(0, 18));
}

export function checkLocally(policy: WalletPolicy | null, to: string, vee: string): Refusal | null {
  if (!policy) return null; // unreadable: let chain-svc decide rather than guess either way
  if (policy.frozen) return 'frozen';
  if (veeToWei(vee) > veeToWei(String(policy.max_per_tx))) return 'over_max_per_tx';
  // Deny beats allow, and an empty allow list denies everything.
  if (policy.deny.some((p) => matchesPattern(p, to))) return 'counterparty_denied';
  if (!policy.allow.some((p) => matchesPattern(p, to))) return 'counterparty_denied';
  return null;
}
