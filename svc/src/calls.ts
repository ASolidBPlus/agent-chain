// §2. `policies/calls.json` - the allowlist, and the whole security boundary of
// the generic call op.
//
// Everything a persona may do on chain beyond `send` is in this file. It is
// HUB-SET: written into the bind-mounted policy directory by whoever runs the
// scenario, edited between turns, and never reviewed by anyone reading this
// code. So the loader fails CLOSED in every direction, and "closed" has a
// specific shape:
//
//   absent    -> an empty allowlist. NOT an error: most scenarios do not use
//                the call op, and refusing to boot without the file would make
//                the op mandatory rather than available.
//   malformed -> an empty allowlist, and the reason in the log. Not a boot
//                failure, because a scenario's typo must not take the service
//                down; and not a partial load, because dropping the entries
//                that would not parse turns one typo into a silent widening of
//                everything else.
//   one bad   -> THE WHOLE FILE IS REFUSED. An entry naming a contract that is
//     entry      not deployed is usually a deployment that moved under a file
//                nobody updated, and the entries around it describe a world
//                that no longer exists.
//
// READ AT REQUEST TIME, like the per-wallet policies (Treasury.policyFor), with
// an mtime cache so a 1 kB file is not re-parsed per request. A request takes
// ONE SNAPSHOT and every check in that request reads it, so a reload cannot
// apply one version to the kind check and another to the caps.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AbiFunction, AbiParameter } from 'viem';
import { assertSupportedType } from './callargs.ts';
import { defaultToken, type Modules } from './modules.ts';
import {
  matchesPattern,
  WALLET_KINDS,
  type PolicyDefaults,
  type WalletKind,
} from './policy.ts';

export type AddressRule = 'token' | 'contract' | 'name' | 'any';

/// Which argument carries money, and in which token: a fixed registry key, or
/// "the token whose address is argument i" - which is what `convert(source,
/// target, amountIn, …)` needs, because the token is chosen per call.
export interface AmountRule {
  arg: number;
  token: string | { arg: number };
}

export interface CallEntry {
  contract: string;
  function: string;
  /// Which wallet kinds may call it through `call`. Empty is legal only on an
  /// admin-only entry.
  kinds: WalletKind[];
  /// Callable by the hub through `admin-call`. Written down even though
  /// platform scope could bypass a list, so the hub's powers are on the record
  /// beside the personas'.
  admin: boolean;
  read: boolean;
  amount?: AmountRule;
  /// Whole units of the amount's token. Increment 3 has no per-wallet per-token
  /// caps, so an amount in a token other than the default carries the only
  /// bound there is; increment 4 retires this.
  // `perTxCap` and `uncapped` were here for one release and are retired: caps
  // are per wallet per token in policy now, and an entry still carrying either
  // is refused at load rather than ignored.
  intentArg?: number;
  maxPerStage?: number;
  addressArgs: Record<number, AddressRule>;
  /// Resolved at load, so nothing downstream looks it up again and nothing can
  /// disagree about which function this entry names.
  abiFunction: AbiFunction;
}

export interface Allowlist {
  entries: CallEntry[];
  find(contract: string, fn: string): CallEntry | undefined;
}

const EMPTY: Allowlist = { entries: [], find: () => undefined };

/// What the call op needs from the allowlist: one snapshot, per request.
///
/// AN INTERFACE RATHER THAN THE CLASS, so the thing that reads a file and the
/// thing that answers questions are separable. A test of the call op should not
/// need a directory, and a test of the loader should not need a chain.
export interface CallPolicySource {
  snapshot(): Allowlist;
}

/// The closed allowlist: nothing is callable. What a deployment with no
/// calls.json has, and what a test that is not about the call op wants.
export function closedCallPolicy(): CallPolicySource {
  return { snapshot: () => EMPTY };
}

/// A fixed allowlist, for a test that IS about the call op.
export function fixedCallPolicy(entries: CallEntry[]): CallPolicySource {
  const byKey = new Map(entries.map((e) => [`${e.contract}.${e.function}`, e]));
  return { snapshot: () => ({ entries, find: (c, f) => byKey.get(`${c}.${f}`) }) };
}

/// Whole units, as every other cap on these wires is written: a decimal string,
/// digits only. `isCap` refuses a JSON number for the same reason.
const WHOLE_UNITS = /^\d{1,30}$/;

/// Function names that hand one address the right to spend another's balance.
///
/// The ERC-20 pair, plus the two extensions a token is likely to carry. Listed
/// by NAME rather than detected by shape because there is no shape to detect -
/// `approve(address,uint256)` is indistinguishable from any other two-argument
/// setter, and what makes it different is what the CONTRACT does with it.
const APPROVAL_FUNCTIONS = new Set([
  'approve',
  'increaseAllowance',
  'decreaseAllowance',
  'permit',
]);

/// Where an `address` hides inside a parameter, or null if there is none below
/// the top level. The top level itself is fine - that is what `addressArgs`
/// names - so the walk starts one level in.
function nestedAddressIn(param: AbiParameter): string | null {
  const arr = /^(.*)\[\d*\]$/.exec(param.type);
  if (arr) {
    const element = { ...param, type: arr[1]! } as AbiParameter;
    return element.type === 'address' || nestedAddressIn(element) ? 'an array' : null;
  }
  if (param.type === 'tuple') {
    const components = (param as { components?: readonly AbiParameter[] }).components ?? [];
    for (const c of components) {
      if (c.type === 'address' || nestedAddressIn(c)) return 'a tuple';
    }
  }
  return null;
}

function assertObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

/// One entry, validated against the LIVE REGISTRY rather than against itself.
///
/// Every refusal names the entry, because a file with a dozen entries needs to
/// say which one - and the author is looking at their own JSON, not at this.
function parseEntry(raw: unknown, index: number, modules: Modules): CallEntry {
  const e = assertObject(raw, `calls[${index}]`);
  const contract = e.contract;
  const name = e.function;
  if (typeof contract !== 'string' || typeof name !== 'string') {
    throw new Error(`calls[${index}] needs a "contract" and a "function"`);
  }
  const where = `"${name}" on ${contract}`;

  const registered = modules.byKey.get(contract);
  if (!registered) throw new Error(`no contract "${contract}" in this deployment (${where})`);

  const matches = registered.abi.filter(
    (item): item is AbiFunction => item.type === 'function' && item.name === name,
  );
  if (matches.length === 0) {
    throw new Error(`"${name}" is not a function of ${contract}`);
  }
  if (matches.length > 1) {
    // The name does not identify one function, and the two differ in ARGUMENT
    // TYPES - which is exactly what the validator, the amount rule and the
    // address rules all read. Picking either would encode a call the author did
    // not write.
    throw new Error(`"${name}" is overloaded in ${contract}; not supported`);
  }
  const abiFunction = matches[0]!;
  const inputs = abiFunction.inputs as readonly AbiParameter[];

  if (abiFunction.stateMutability === 'payable') {
    throw new Error(`payable functions are not callable; the chain has no ETH economy (${where})`);
  }

  // NO APPROVALS, AND THE GENERIC OP IS WHERE THAT STOPS BEING AUTOMATIC.
  //
  // "Allowances/approvals of any kind" is a NON-GOAL of this increment, and it
  // used to hold for free: nothing in chain-svc called `approve`, so the §8.10
  // grep gate found no line outside a comment. It does not hold for free any
  // more. The registry's ABIs are generated from the whole of contracts/src,
  // the Token is a standard ERC-20, and the standard declares `approve` - so
  // `{"contract": "play", "function": "approve"}` is now a manifest away from
  // being a legal allowlist entry, and the money rail's push-only property
  // would be a file's typo away from gone.
  //
  // Refused BY NAME at load, on every contract rather than on tokens: a custom
  // contract is free to name a function `approve`, and if it does, the same
  // question applies to it.
  if (APPROVAL_FUNCTIONS.has(name)) {
    throw new Error(
      `"${name}" grants an allowance, and this chain has none: money is push-only and a call ` +
        `never spends what it was not given (${where})`,
    );
  }

  // Every parameter must be one the validator can check. AT LOAD, so the
  // operator who wrote the file meets it - never at call time, in front of a
  // persona, as a refusal nobody can act on.
  for (const input of inputs) {
    try {
      assertSupportedType(input);
    } catch (err) {
      throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const read = e.read === true;
  const isView = abiFunction.stateMutability === 'view' || abiFunction.stateMutability === 'pure';
  if (read && !isView) {
    throw new Error(`"${name}" is not view or pure in ${contract}; it cannot be a "read" entry`);
  }
  if (!read && isView) {
    // The mirror, and it matters as much: a view served through `call` would
    // reserve an intent, spend stage budget and sign a transaction to learn
    // something `read` answers for free.
    throw new Error(`"${name}" is view; it needs "read": true (${contract})`);
  }

  const admin = e.admin === true;
  const kinds: WalletKind[] = [];
  if (e.kinds !== undefined) {
    if (!Array.isArray(e.kinds)) throw new Error(`${where}: "kinds" is not an array`);
    for (const k of e.kinds) {
      if (!(WALLET_KINDS as readonly unknown[]).includes(k)) {
        throw new Error(`${where}: "${String(k)}" is not a wallet kind`);
      }
      kinds.push(k as WalletKind);
    }
  }
  if (kinds.length === 0 && !admin) {
    // An entry no kind may call and the hub may not call either is not a narrow
    // permission - it is a line that does nothing, written by an author who
    // believed it did something.
    throw new Error(`${where}: no "kinds" and not "admin"; nothing could call it`);
  }

  // AN ADDRESS NESTED IN AN ARRAY OR A TUPLE IS NOT CALLABLE BY A WALLET, and
  // refusing it here is the only place it can fail safely.
  //
  // The chain of steps that makes it reachable is each individually right:
  // `assertSupportedType` accepts `address[]` because the validator can check
  // one; `validateOne` accepts `{"name":"alpha"}` at every depth, because the
  // wire form is the wire form; and §3.2 step 5 resolves `addressArgs`, which
  // is keyed by TOP-LEVEL argument index and has no way to name an element
  // inside an array. So the wire object would travel all the way to
  // `encodeFunctionData`, which cannot encode an object as an address - and the
  // failure would reach a persona as a 502 chain_error, which says the chain is
  // broken about an allowlist entry nobody could have used.
  //
  // ADMIN-ONLY ENTRIES ARE EXEMPT because platform scope passes raw checksummed
  // addresses, which encode at any depth. An entry with BOTH `admin` and
  // `kinds` is refused: wallet scope can reach it.
  if (kinds.length > 0) {
    for (let i = 0; i < inputs.length; i++) {
      const nested = nestedAddressIn(inputs[i]!);
      if (nested) {
        throw new Error(
          `${where}: argument ${i} (${inputs[i]!.name ?? ''}) has an address nested in ${nested}, ` +
            `and addressArgs can only name a top-level argument - so a wallet-scope caller has no ` +
            `way to pass it. Admin-only entries may use it; wallet-callable ones may not`,
        );
      }
    }
  }

  const inRange = (i: unknown, what: string): number => {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= inputs.length) {
      throw new Error(`${where}: ${what} ${String(i)} is not an argument index`);
    }
    return i;
  };

  let amount: AmountRule | undefined;
  if (e.amount !== undefined) {
    const a = assertObject(e.amount, `${where}: "amount"`);
    const arg = inRange(a.arg, 'amount.arg');
    if (inputs[arg]!.type !== 'uint256') {
      throw new Error(`${where}: amount.arg ${arg} is ${inputs[arg]!.type}, not uint256`);
    }
    if (typeof a.token === 'string') {
      const token = modules.tokens.find((t) => t.key === a.token);
      if (!token) {
        throw new Error(`${where}: amount.token "${a.token}" is not a token in this deployment`);
      }
      amount = { arg, token: a.token };
    } else {
      const t = assertObject(a.token, `${where}: "amount.token"`);
      const tokenArg = inRange(t.arg, 'amount.token.arg');
      if (inputs[tokenArg]!.type !== 'address') {
        throw new Error(
          `${where}: amount.token.arg ${tokenArg} is ${inputs[tokenArg]!.type}, not address`,
        );
      }
      amount = { arg, token: { arg: tokenArg } };
    }
  }

  // §2 (multi-token). `perTxCap` and `uncapped` ARE RETIRED, and an entry still
  // carrying either is REFUSED rather than ignored.
  //
  // They existed for one release because caps were denominated in the default
  // token only, so an amount in any other token was bounded by nothing the
  // wallet carried and the ENTRY had to state the bound. Caps are now per
  // wallet PER TOKEN, so the wallet carries a bound for every currency it may
  // spend and the entry has nothing left to say about it.
  //
  // REFUSED, NOT IGNORED, and that is the whole point of the line. A retired
  // field read as a no-op would leave an operator believing a bound is in force
  // that nothing enforces - the most expensive kind of stale config, because it
  // looks like a policy and behaves like a comment.
  for (const retired of ['perTxCap', 'uncapped'] as const) {
    if (e[retired] !== undefined) {
      throw new Error(
        `${where}: "${retired}" is retired; caps are per wallet per token in policy`,
      );
    }
  }

  let intentArg: number | undefined;
  if (e.intentArg !== undefined) {
    if (read) {
      // A read signs nothing and reserves no intent, so there is no intent id
      // to inject. Asking for one is an author who thinks a read is a call.
      throw new Error(`${where}: "intentArg" on a read entry`);
    }
    intentArg = inRange(e.intentArg, 'intentArg');
    if (inputs[intentArg]!.type !== 'bytes32') {
      throw new Error(`${where}: intentArg ${intentArg} is ${inputs[intentArg]!.type}, not bytes32`);
    }
  }

  let maxPerStage: number | undefined;
  if (e.maxPerStage !== undefined) {
    if (typeof e.maxPerStage !== 'number' || !Number.isInteger(e.maxPerStage) || e.maxPerStage < 1) {
      throw new Error(`${where}: "maxPerStage" must be an integer of at least 1`);
    }
    maxPerStage = e.maxPerStage;
  }

  const addressArgs: Record<number, AddressRule> = {};
  if (e.addressArgs !== undefined) {
    const rules = assertObject(e.addressArgs, `${where}: "addressArgs"`);
    for (const [key, rule] of Object.entries(rules)) {
      if (!/^\d+$/.test(key)) throw new Error(`${where}: addressArgs key "${key}" is not an index`);
      const i = inRange(Number(key), 'addressArgs');
      if (inputs[i]!.type !== 'address') {
        throw new Error(`${where}: addressArgs ${i} is ${inputs[i]!.type}, not address`);
      }
      if (rule !== 'token' && rule !== 'contract' && rule !== 'name' && rule !== 'any') {
        throw new Error(`${where}: addressArgs ${i} rule "${String(rule)}" is not one of token, contract, name, any`);
      }
      addressArgs[i] = rule;
    }
  }

  return {
    contract,
    function: name,
    kinds,
    admin,
    read,
    amount,
    intentArg,
    maxPerStage,
    addressArgs,
    abiFunction,
  };
}

/// The default token's key, or undefined on a deployment with no token module -
/// where every `amount` is in a non-default token by definition, so every one
/// of them must carry its own bound.
function defaultTokenKey(modules: Modules): string | undefined {
  try {
    return defaultToken(modules).key;
  } catch {
    return undefined;
  }
}

/// §2. A warning, at load, for the entry that will be refused at call time.
///
/// An allow list is matched against the CONTRACT KEY when a call moves money,
/// and `agent`/`burner` carry `["*.{tld}"]`, which no contract key matches -
/// so `policy-defaults.json` names every callable contract explicitly. This
/// says so when it does not.
///
/// A WARNING, NOT A REFUSAL, and the distinction is load-bearing: the defaults
/// are one of TWO sources, and the other - a per-scenario policy override -
/// cannot be seen from here at all. Refusing the file on a defaults miss would
/// close the op for a deployment whose per-wallet policies are perfectly
/// correct; saying nothing would leave an author with a `counterparty_denied`
/// they cannot explain. So it warns, and the call-time refusal names the fix.
function warnAboutUnallowedContracts(
  entries: CallEntry[],
  defaults: PolicyDefaults | undefined,
  modules: Modules,
  log: (line: string) => void,
): void {
  if (!defaults) return;
  for (const entry of entries) {
    // ANY amount reaches enforcePolicy now. This used to skip everything but
    // the default token, because caps were denominated in it and other tokens
    // were bounded by the entry's own `perTxCap` - retired with per-token caps,
    // so the allow list is consulted for every currency a call can move.
    if (entry.amount === undefined) continue;

    for (const kind of entry.kinds) {
      const allow = defaults[kind]?.allow ?? [];
      const allowed = allow.some((p) => matchesPattern(p, entry.contract));
      if (!allowed) {
        log(
          `[chain-svc] calls.json: "${entry.function}" on ${entry.contract} is callable by ` +
            `${kind}, and ${kind}'s default allow list does not name "${entry.contract}" - ` +
            `a call moving the default token will be refused counterparty_denied. Add it to ` +
            `policy-defaults.json, or to each wallet's own policy.`,
        );
      }
    }
  }
}

function parseFile(text: string, modules: Modules): Allowlist {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (parsed.schema !== 1) {
    throw new Error(`schema ${String(parsed.schema)} unsupported (expected 1)`);
  }
  if (!Array.isArray(parsed.calls)) throw new Error(`"calls" is not an array`);

  const entries = (parsed.calls as unknown[]).map((raw, i) => parseEntry(raw, i, modules));

  // Two entries for one (contract, function) is two answers to one lookup.
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.contract}.${entry.function}`;
    if (seen.has(key)) throw new Error(`"${entry.function}" on ${entry.contract} appears twice`);
    seen.add(key);
  }

  const byKey = new Map(entries.map((e) => [`${e.contract}.${e.function}`, e]));
  return { entries, find: (c, f) => byKey.get(`${c}.${f}`) };
}

/// Reads `calls.json` on demand, re-parsing only when the file changes.
export class CallPolicy implements CallPolicySource {
  private readonly path: string;
  private readonly modules: Modules;
  private readonly log: (line: string) => void;
  /// The mtime+size the cached snapshot was parsed from, or null for "no file".
  private stamp: string | null | undefined;
  private cached: Allowlist = EMPTY;
  /// So an unchanged broken file does not log once per request.
  private complainedAbout: string | null = null;

  constructor(
    policyDir: string,
    modules: Modules,
    log: (line: string) => void,
    /// The kind defaults, for the load-time warning only. Optional because a
    /// test of the LOADER has no business needing them.
    private readonly policyDefaults?: PolicyDefaults,
  ) {
    this.path = join(policyDir, 'calls.json');
    this.modules = modules;
    this.log = log;
    // Read once at construction so the boot line is written at boot, where an
    // operator is looking, rather than at the first call.
    this.snapshot();
  }

  /// The allowlist as of now. A VALUE, not a view: the caller holds it for the
  /// whole request, so a reload mid-request cannot apply one version to the
  /// kind check and another to the caps.
  snapshot(): Allowlist {
    let stamp: string | null;
    try {
      const s = statSync(this.path);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      stamp = null;
    }

    if (stamp === this.stamp) return this.cached;
    this.stamp = stamp;

    if (stamp === null) {
      this.cached = EMPTY;
      this.say(`[chain-svc] calls.json: none at ${this.path}; the generic call op is closed`);
      return this.cached;
    }

    try {
      this.cached = parseFile(readFileSync(this.path, 'utf8'), this.modules);
      this.complainedAbout = null;
      warnAboutUnallowedContracts(this.cached.entries, this.policyDefaults, this.modules, this.log);
      this.log(
        `[chain-svc] calls.json: ${this.cached.entries.length} entr${
          this.cached.entries.length === 1 ? 'y' : 'ies'
        } from ${this.path}`,
      );
    } catch (err) {
      // CLOSED, not "the previous one". An edit that breaks the file is exactly
      // when its author believes they have CHANGED the rules, so continuing to
      // serve the last good snapshot would enforce a policy nobody is looking
      // at any more.
      this.cached = EMPTY;
      this.say(
        `[chain-svc] calls.json at ${this.path} is not usable: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The generic call op is CLOSED until it is fixed.`,
      );
    }
    return this.cached;
  }

  private say(line: string): void {
    if (this.complainedAbout === line) return;
    this.complainedAbout = line;
    this.log(line);
  }
}
