// Server-side enforcement of a wallet's spending policy (spec S5, ruled 20:57).
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

export type WalletKind = 'org' | 'agent' | 'burner';

/// The caps written into an agent's policy file at spawn, which wallet-mcp
/// enforces (spec S5).
export interface AgentPolicy {
  max_per_tx: number;
  max_per_stage: number;
  allow: string[];
  deny: string[];
}

export type PolicyDefaults = Record<WalletKind, AgentPolicy>;

/// Loaded from policy-defaults.json rather than held as a constant here, so the
/// numbers are game balance the owner tunes and not something a builder chose
/// (ruled 20:49 UTC). Read once at startup and FAILS LOUDLY if missing or
/// malformed: a wallet spawned with no caps is an unbounded wallet, so this
/// must not fall back to something permissive.
export function loadPolicyDefaults(path: string): PolicyDefaults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`chain-svc: cannot read policy defaults at ${path}: ${(err as Error).message}`);
  }
  const out = {} as PolicyDefaults;
  for (const kind of ['org', 'agent', 'burner'] as const) {
    const entry = (parsed as Record<string, unknown>)?.[kind];
    if (!isPolicy(entry)) {
      throw new Error(`chain-svc: policy defaults at ${path} have no valid "${kind}" entry`);
    }
    out[kind] = entry;
  }
  return out;
}

export function isPolicy(value: unknown): value is AgentPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const names = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.length > 0);
  return positive(p.max_per_tx) && positive(p.max_per_stage) && names(p.allow) && names(p.deny);
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


/// `*` matches anything; `*.vee` matches any name with that suffix. Deliberately
/// not a general glob: the patterns come from a game config, and a regex
/// dialect nobody has specified is a way to write an allow rule that silently
/// matches more than its author meant.
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  return pattern === name;
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
export function stageCapWei(policy: AgentPolicy): bigint {
  return BigInt(policy.max_per_stage) * 10n ** 18n;
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
/// That is the ruled case (04:05) and the common one, because `reverse[target]`
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
}): void {
  const { policy, to, canonical, amount } = args;
  const perTx = BigInt(policy.max_per_tx) * 10n ** 18n;

  if (amount > perTx) {
    throw new HttpError('over_max_per_tx', `max_per_tx is ${policy.max_per_tx} VEE`);
  }

  // BOTH NAMES, and the two lists use them differently ON PURPOSE (ruled 04:05).
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
