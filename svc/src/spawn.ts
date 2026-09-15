// Wallet spawn, vanity aliases and retirement (spec S4).
//
// The identity rule this file exists to hold: a wallet is keyed by the
// QUALIFIED id `<org label>:<local id>`, composed by the caller from the game's
// org assignment and validated here. Nothing in this file reads a mesh alias, a
// message origin or a `from` field - those are observer-relative, and money
// keyed on them lands in the wrong account the first time a third mesh joins.

import { randomBytes } from 'node:crypto';
import { parseEther, type Address } from 'viem';
import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NameRegistryAbi, TokenAbi } from './abi.ts';
import type { Chain } from './chain.ts';
import { asChainError, ZERO_FEES } from './chain.ts';
import type { Config } from './config.ts';
import { HttpError } from './errors.ts';
import type { Keystore } from './keystore.ts';
import type { Resolver } from './resolver.ts';
import type { Store } from './store.ts';
import { hashToken } from './auth.ts';
import { defaultToken, requireNames, resolveToken, type TokenModule } from './modules.ts';
import { mergePolicy, loadPolicyDefaults, readPolicyFile, isWalletKind, WALLET_KINDS, isUnreadable,
  type AgentPolicy, type PolicyDefaults, type PolicyRead, type WalletKind,
  assertPatternsUsable,
} from './policy.ts';
import {
  assertAlias,
  assertCanonicalAgentId,
  keyFileName,
  parseVee,
} from './validate.ts';

/// Every wallet gets native ETH at spawn so nothing ever fails on gas even if
/// the chain's zero-gas flags change (spec S2).
const GAS_ENDOWMENT = parseEther('1');

/// A caller-supplied policy (hub-core setting per-agent values, spec S4).
export interface SpawnRequest {
  agentId?: unknown;
  /// §1. Seed funding per token: `[{ token, amount }]`, `token` a manifest key
  /// or a symbol like every other token argument. Supersedes `fundVee`, which
  /// can only ever name the default token - a two-token deployment could not
  /// fund its second currency at spawn at all.
  fund?: unknown;
  fundVee?: unknown;
  kind?: unknown;
  alias?: unknown;
  policy?: unknown;
}

/// §1. `fund?: [{ token, amount }]` — parsed and RESOLVED before any side
/// effect, so a bad token or a bad amount refuses without leaving a key file.
///
/// Each amount is parsed at ITS OWN token's decimals. Parsing them all at the
/// default token's scale is the increment-3 defect exactly: invisible while
/// every token is 18 dp, and a 1e12x error the moment one is 6.
///
/// A token named TWICE is refused rather than summed or last-wins. Both
/// readings are defensible, which is what makes guessing between them wrong:
/// the caller wrote something ambiguous about money.
function parseFundList(
  value: unknown,
  modules: Parameters<typeof resolveToken>[0],
): Array<{ token: TokenModule; amount: bigint }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError('invalid_request', 'fund must be an array of {token, amount}');
  }
  const seen = new Set<string>();
  return value.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new HttpError('invalid_request', `fund[${i}] must be an object {token, amount}`);
    }
    const entry = raw as { token?: unknown; amount?: unknown };
    // `resolveToken` refuses an absent token here rather than defaulting: an
    // ENTRY IN A LIST that names no token is a mistake, where an absent `token`
    // on a single-token request is the documented default. The same argument
    // means different things in the two shapes.
    if (entry.token === undefined || entry.token === null || entry.token === '') {
      throw new HttpError('invalid_request', `fund[${i}] must name a token`);
    }
    const token = resolveToken(modules, entry.token);
    if (seen.has(token.key)) {
      throw new HttpError('invalid_request', `fund names ${token.key} twice; say what it should receive once`);
    }
    seen.add(token.key);
    const amount = parseVee(entry.amount, token.decimals, token.symbol, `fund[${i}].amount`);
    if (amount <= 0n) {
      throw new HttpError('invalid_amount', `fund[${i}].amount must be greater than zero`);
    }
    return { token, amount };
  });
}

export class Spawner {
  private readonly policyDefaults: PolicyDefaults | null;

  constructor(
    private readonly config: Config,
    private readonly chain: Chain,
    private readonly keystore: Keystore,
    private readonly store: Store,
    private readonly resolver: Resolver,
    policyDefaults?: PolicyDefaults | null,
  ) {
    // NULL WHEN NOBODY POINTED AT A FILE. Loading the shipped example would be
    // this service deciding a deployment's game balance for it.
    this.policyDefaults =
      policyDefaults ??
      (config.policyDefaultsPath
        ? loadPolicyDefaults(
            config.policyDefaultsPath,
            chain.modules.names?.tld,
            chain.modules.tokens.map((t) => t.key),
          )
        : null);
  }

  /// 256 bits of randomness, handed back ONCE and kept only as a hash. If it is
  /// lost, the answer is `rotate`, not a lookup: chain-svc cannot reveal a
  /// wallet token it never stored.
  private issueWalletToken(agentId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.store.setWalletTokenHash(agentId, hashToken(token));
    return token;
  }

  rotateToken(agentId: string): { walletToken: string } {
    assertCanonicalAgentId(agentId);
    if (!this.store.spawnedAddress(agentId)) {
      throw new HttpError('wallet_not_found', `no wallet for ${agentId}`);
    }
    // Replaces the stored hash, which is what revokes the previous token -
    // there is no list of superseded tokens to forget to clean up.
    return { walletToken: this.issueWalletToken(agentId) };
  }

  async spawn(
    body: SpawnRequest,
  ): Promise<{ agentId: string; address: Address; alias?: string; walletToken?: string }> {
    const agentId = assertCanonicalAgentId(body.agentId);
    const kind = this.parseKind(body.kind);
    const alias = body.alias === undefined || body.alias === null ? undefined : assertAlias(body.alias);
    // The default token may be ABSENT here: spawn runs on a names-only
    // deployment too, and only the funding half needs a token. The scale is
    // used to parse a value that must then be zero, and the check below is
    // what refuses a non-zero one - so this cannot quietly parse money at the
    // wrong scale.
    const tok = this.chain.modules.tokens[0];
    const fundVee = parseVee(body.fundVee ?? 0, tok?.decimals ?? 18, tok?.symbol ?? 'tokens', 'fundVee');

    // TWO NAMES FOR ONE THING IS TWO THINGS, the same rule the wire alias
    // follows: a request carrying both is refused rather than resolved by
    // preferring either. Silently picking one is a guess about which the caller
    // meant, and the one place a guess is expensive is where it moves money.
    if (body.fund !== undefined && body.fundVee !== undefined) {
      throw new HttpError(
        'invalid_request',
        'a spawn carries either "fund" or the legacy "fundVee", never both',
      );
    }
    // RESOLVED AND PARSED HERE, before any side effect, so a bad token or a bad
    // amount refuses without leaving a key file behind - the same position the
    // module checks below take, for the same reason.
    const fund = parseFundList(body.fund, this.chain.modules);
    // hub-core may set per-agent caps; otherwise they come by kind from the
    // game-balance file, never from a constant in this module.
    // A supplied policy is a PATCH over the kind defaults, not a complete
    // document: `{allow, deny}` with the caps left alone is the harness's whole
    // use, and demanding all four made that the one shape that failed while
    // sending nothing succeeded.
    // THE BASE IS THE KIND'S DEFAULTS WHEN THERE ARE ANY, and nothing when
    // there are not. A spawn that supplies no `policy` against a deployment
    // with no defaults produces a wallet with no rules - which is what "policy
    // is opt-in" means at the point a wallet comes into existence.
    const policy = mergePolicy(body.policy, this.policyDefaults?.[kind] ?? null);

    // A burner is deliberately an unnamed address the game has to trace, so a
    // named burner is a contradiction rather than a request to be helpful about.
    if (kind === 'burner' && alias !== undefined) {
      throw new HttpError('invalid_request', 'a burner registers no names, so it cannot have an alias');
    }

    // THE MODULE CHECKS SIT HERE, beside the other request-shape refusals, and
    // the position is the point: BEFORE the idempotency return and BEFORE the
    // first side effect (`keystore.create`). A spawn asking for something this
    // deployment cannot do must refuse without leaving a key file, a policy
    // file or a store row behind - otherwise the retry after the refusal takes
    // the idempotent path and reports success for the request that was refused.
    //
    // Spawn itself needs NEITHER module: a wallet is a key, a token and a
    // policy file, and all three exist on a deployment with no contracts at
    // all. Only the two optional halves need one each.
    if (fundVee > 0n && this.chain.modules.tokens.length === 0) {
      throw new HttpError(
        'module_not_deployed',
        'fundVee requires a token module; omit it or deploy one',
      );
    }
    // `fund` GETS NO GUARD HERE, and the absence is deliberate. A `fund` with
    // entries cannot reach this point on a tokenless deployment - `parseFundList`
    // runs `resolveToken` above and refuses by name - and a `fund: []` asks for
    // nothing, so there is nothing to refuse: the caller gets a wallet with no
    // balances, which is what a names-only deployment means.
    //
    // This comment previously described a guard that was never written, sitting
    // above the ALIAS guard as though it introduced it. Nothing compiles a
    // comment, so a reader would have gone looking for a check that does not
    // exist and concluded the code was wrong - the same fault as the stale
    // `perTxCap` header this increment already fixed, made the same way.
    if (alias !== undefined && this.chain.modules.names === undefined) {
      throw new HttpError(
        'module_not_deployed',
        'alias requires a names module; omit it or deploy one',
      );
    }

    // Fully idempotent (spec S4): a retried spawn must never mint money. The
    // marker is written only after every step succeeded, so a half-finished
    // spawn resumes below instead of being reported as done.
    const already = this.store.spawnedAddress(agentId);
    if (already) {
      // Deliberately NO walletToken on a repeat: it was returned once and only
      // its hash was kept, so there is nothing to return even if we wanted to.
      // A caller that lost it calls rotate.
      return { agentId, address: already as Address, ...(alias ? { alias } : {}) };
    }

    // Both entry points enforce the canonical-deny rule; this was on the PATCH
    // path only, so a deny entry refused there was accepted here.
    //
    // Placed AFTER the cheap validation and the idempotency check, because it
    // reads the registry: an argument refusal should not depend on the chain
    // being reachable, and a repeat spawn should not pay for a check whose
    // answer it already stored.
    await this.assertDenyEntriesAreCanonical(policy.deny ?? []);

    const address = (await this.keystore.has(agentId))
      ? (await this.keystore.load(agentId)).address
      : (await this.keystore.create(agentId)).address;

    await this.endowGas(address);
    if (fundVee > 0n) await this.fundToken(address, defaultToken(this.chain.modules), fundVee);
    // ONE RESOLVED TokenModule PER ENTRY, carried into the balance read AND the
    // transfer - the same discipline set-balance needed: read and write are two
    // uses of one resolution, and sourcing them separately is what lets a seed
    // measure one token and move another.
    for (const entry of fund) await this.fundToken(address, entry.token, entry.amount);
    // REGISTRATION NEEDS A REGISTRY, and a burner deliberately has no name.
    // Both conditions, not just the kind: without this the call reached
    // `requireNames` inside the registry write, threw module_not_deployed, and
    // came back to the caller as a 502 chain_error - a refusal about the
    // deployment's shape, reported as the chain being broken.
    //
    // The wallet is still spawned: a key, a wallet token and a policy file do
    // not need a registry. It simply has no name, which is what a deployment
    // without a names module means.
    if (kind !== 'burner' && this.chain.modules.names !== undefined) {
      await this.registerIfAbsent(agentId, address);
      if (alias) await this.registerIfAbsent(alias, address);
    }
    // A FILE ONLY WHEN THE CALLER WROTE RULES. Until v0.8.0 every spawn wrote
    // one, baking the kind defaults into a per-wallet document - so every
    // wallet had "its own" policy that was really a snapshot of the kind's, and
    // a later change to the kind defaults silently did not reach any existing
    // wallet. A wallet spawned without `policy` now has no file and follows its
    // kind's defaults live, or nothing if none are loaded.
    if (body.policy !== undefined) await this.writePolicyFile(agentId, policy);

    // Minted before the marker: if the process dies between the two, the retry
    // re-runs this and issues a fresh token, rather than completing a spawn
    // whose agent has no way to authenticate.
    const walletToken = this.issueWalletToken(agentId);

    // The EFFECTIVE kind - the post-parseKind value, what was actually enforced -
    // because that is what answers the audit question. Whether the caller
    // SPECIFIED it or fell through to the default is a hub-core call-site
    // question, not a chain-svc record question, and is deliberately not stored.
    this.store.markSpawned(agentId, address, kind);
    return { agentId, address, ...(alias ? { alias } : {}), walletToken };
  }

  async addAlias(body: { agentId?: unknown; alias?: unknown }): Promise<{ txHash: string }> {
    const agentId = assertCanonicalAgentId(body.agentId);
    const alias = assertAlias(body.alias);

    const wallet = this.store.spawnedAddress(agentId);
    if (!wallet) throw new HttpError('wallet_not_found', `no wallet for ${agentId}`);

    const existing = await this.resolver.lookup(alias);
    if (existing) throw new HttpError('invalid_name', `${alias} is already registered`);

    return { txHash: await this.registerFor(alias, wallet as Address) };
  }

  /// Retirement: the WALLET HALF ONLY, standalone and idempotent.
  /// hub-core sequences the composite - mesh admin DELETE /agents
  /// then this - and chain-svc deliberately does not tail the `agent.deleted`
  /// admin log line: it is a log record, not a subscribable event, and coupling
  /// to it would duplicate what hub-core will own.
  async retire(agentId: string): Promise<{ frozen: true }> {
    assertCanonicalAgentId(agentId);

    // Freeze first. If clearing the aliases fails halfway, the wallet is
    // already unable to spend - the safe order.
    this.store.freeze(agentId);
    // §3. RETIREMENT NO LONGER WRITES A POLICY FILE. It used to rewrite the
    // wallet's file with `frozen: true` stamped in, preserving whatever caps
    // the wallet was spawned with. At v0.8.0 that would CREATE a file for a
    // wallet that has none, bake the kind defaults into it, and leave a field
    // nothing reads - turning retirement into an act that writes rules nobody
    // asked for, which is the thing this release removes.
    //
    // The `frozen` table above IS the record. A policy document is the
    // operator's rules; retirement is not one of them.

    const wallet = this.store.spawnedAddress(agentId);
    if (wallet) {
      for (const alias of await this.resolver.aliasesOf(wallet as Address)) {
        // setTargetFor, not setTarget: retirement is a platform action and must
        // not depend on the agent's key still being decryptable.
        await this.send('setTargetFor', [alias, '0x0000000000000000000000000000000000000000']);
      }
    }
    return { frozen: true };
  }

  private parseKind(value: unknown): WalletKind {
    if (value === undefined || value === null) return 'agent';
    if (isWalletKind(value)) return value;
    // A guard in test/spawn.test.ts extracts this function by counting braces,
    // so a stray } in a comment here would truncate what it reads. It blanks
    // comments first, which is why this line is safe - and this line is what
    // witnesses that it still does.
    //
    // Built FROM the constant, so the message cannot drift from the condition
    // it explains: a kind added to WALLET_KINDS is accepted here and named here
    // in the same edit, and there is no second list to forget.
    throw new HttpError('invalid_request', `kind must be one of ${WALLET_KINDS.join(', ')}`);
  }

  private async endowGas(address: Address): Promise<void> {
    try {
      const balance = await this.chain.publicClient.getBalance({ address });
      if (balance >= GAS_ENDOWMENT) return; // already endowed by an earlier attempt
      const hash = await this.chain.walletClient.sendTransaction({
        account: this.chain.walletClient.account!,
        chain: this.chain.viemChain,
        to: address,
        value: GAS_ENDOWMENT - balance,
        ...ZERO_FEES,
      });
      await this.chain.publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      throw asChainError(err);
    }
  }

  private async fundToken(address: Address, token: TokenModule, amount: bigint): Promise<void> {
    try {
      const balance = (await this.chain.publicClient.readContract({
        address: token.address,
        abi: TokenAbi,
        functionName: 'balanceOf',
        args: [address],
      })) as bigint;
      // Only tops up a wallet that never received its seed: a resumed spawn
      // must not double-fund one that did.
      if (balance >= amount) return;

      const hash = await this.chain.walletClient.writeContract({
        account: this.chain.walletClient.account!,
        chain: this.chain.viemChain,
        address: token.address,
        abi: TokenAbi,
        functionName: 'transfer',
        args: [address, amount - balance],
        ...ZERO_FEES,
      });
      await this.chain.publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      throw asChainError(err);
    }
  }

  private async registerIfAbsent(name: string, address: Address): Promise<void> {
    const existing = await this.resolver.lookup(name);
    if (existing) {
      if (existing.address.toLowerCase() !== address.toLowerCase()) {
        throw new HttpError('invalid_name', `${name} is already registered to another wallet`);
      }
      return; // an earlier attempt got this far
    }
    await this.registerFor(name, address);
  }

  private async registerFor(name: string, address: Address): Promise<string> {
    return this.send('registerFor', [name, address, address]);
  }

  /// Both registry writes go through here, and both carry ZERO_FEES like every
  /// other send in this service - see test/fees.test.ts, which enumerates every
  /// .writeContract( and .sendTransaction( in src/ and fails if one of them
  /// omits the spread or lets a later key override it.
  ///
  /// This comment is also the fee guard's own fixture. The guard blanks
  /// comments before scanning, because a comment naming a send call used to
  /// produce a phantom block and skip the real sites behind it - and with no
  /// such comment anywhere in src/, that blanking step was unexercised by the
  /// tree and could be deleted with nothing noticing. Documentation the guard
  /// used to reject is the natural place to witness that it no longer does.
  private async send(functionName: 'registerFor' | 'setTargetFor', args: unknown[]): Promise<string> {
    try {
      const hash = await this.chain.walletClient.writeContract({
        account: this.chain.walletClient.account!,
        chain: this.chain.viemChain,
        address: requireNames(this.chain.modules).address,
        abi: NameRegistryAbi,
        functionName,
        args: args as never,
        ...ZERO_FEES,
      });
      await this.chain.publicClient.waitForTransactionReceipt({ hash });
      return hash;
    } catch (err) {
      throw asChainError(err);
    }
  }

  /// What `GET /wallets/:id` reports: the rules that will actually apply, and
  /// WHERE THEY CAME FROM.
  ///
  /// Derived per read. An unreadable file is reported as its own source rather
  /// than as `null` - an operator staring at an unbounded wallet must be able
  /// to tell "nobody wrote rules" from "I wrote rules this service cannot
  /// read", because only the second is something they broke.
  async effectivePolicy(
    agentId: string,
  ): Promise<{ policy: AgentPolicy | null; policySource: 'wallet' | 'kind' | 'none' | 'unreadable' }> {
    const read = await readPolicyFile(this.config.policyDir, agentId, this.chain.modules.tokens[0]?.key);
    if (isUnreadable(read)) return { policy: null, policySource: 'unreadable' };
    if (read !== null) return { policy: read, policySource: 'wallet' };
    const kind = this.store.walletRow(agentId)?.kind;
    const fromKind = this.policyDefaults && kind ? this.policyDefaults[kind] : undefined;
    if (fromKind) return { policy: fromKind, policySource: 'kind' };
    return { policy: null, policySource: 'none' };
  }

  /// The merge base for `PATCH` and for retirement.
  ///
  /// UNREADABLE PROPAGATES rather than falling back: a PATCH over a file this
  /// service cannot read would silently discard whatever the operator wrote,
  /// and `{ clear: true }` is the operation that means "throw it away". The
  /// caller decides; this does not decide for it.
  private async existingPolicy(agentId: string): Promise<PolicyRead> {
    const read = await readPolicyFile(this.config.policyDir, agentId, this.chain.modules.tokens[0]?.key);
    if (read !== null) return read;
    // No file: the base is the wallet's OWN kind's default when defaults are
    // loaded, and nothing otherwise.
    if (!this.policyDefaults) return null;
    const kind = this.store.walletRow(agentId)?.kind;
    return (kind ? this.policyDefaults[kind] : undefined) ?? null;
  }

  /// Partial update of a wallet's policy (harness spec S3). Platform scope.
  ///
  /// `frozen: false` is the ONLY way back from frozen. `DELETE /wallets` keeps
  /// meaning retirement and stays irreversible: it also clears the wallet's
  /// aliases, so un-retiring by un-freezing would return the ability to spend
  /// without the ability to be paid.
  async patchPolicy(
    agentId: string,
    body: {
      frozen?: unknown;
      /// The current shape.
      caps?: unknown;
      /// The LEGACY pair, still accepted from a caller and read against the
      /// default token. Kept because a patch is the one place an operator
      /// types a policy by hand, and the shape they have in front of them is
      /// whatever the last release wrote.
      max_per_tx?: unknown;
      max_per_stage?: unknown;
      allow?: unknown;
      deny?: unknown;
      /// DELETE THE FILE. The one operation that means "this wallet has no
      /// rules of its own" - which a PATCH cannot express, because with every
      /// field optional an absent field means "leave it alone" and there is no
      /// JSON for "remove it".
      clear?: unknown;
    },
  ): Promise<Record<string, unknown>> {
    assertCanonicalAgentId(agentId);
    if (body.clear !== undefined) {
      if (body.clear !== true) {
        throw new HttpError('invalid_request', 'clear is either true or absent');
      }
      // NO OTHER FIELD MAY ACCOMPANY IT. "Delete the file and also set this"
      // has two readings - set it on the cleared file, or set it and then
      // delete - and they differ in what the wallet ends up with.
      const others = Object.keys(body).filter((k) => k !== 'clear');
      if (others.length > 0) {
        throw new HttpError('invalid_request', `clear takes no other fields; got ${others.join(', ')}`);
      }
      // WORKS ON AN UNREADABLE FILE, deliberately: it is the way out of one,
      // and it reads nothing, so there is nothing for a bad document to break.
      await rm(join(this.config.policyDir, keyFileName(agentId)), { force: true });
      return { agentId, cleared: true };
    }
    if (!this.store.spawnedAddress(agentId)) {
      throw new HttpError('wallet_not_found', `no wallet for ${agentId}`);
    }

    // ONE VALIDATOR FOR ONE DOCUMENT. This used to have its own - `assertCap`
    // and `assertPatternList` - while `POST /wallets` used `mergePolicy`, so
    // the two entry points to the same policy file enforced different rules:
    // a wallet spawned with `max_per_tx: "25"` could not be patched in the
    // form it was spawned with, and the form PATCH did accept wrote a JSON
    // number into a file whose other caps were strings.
    //
    // A patch over the CURRENT policy is the same operation as a patch over
    // the kind defaults, so it is the same function with a different base.
    const current = await this.existingPolicy(agentId);
    // THE DEFAULT TOKEN'S KEY, so a PATCH carrying the legacy `max_per_tx` pair
    // is read against it rather than refused. A caller patching the old shape
    // is saying something about the default token; every other token's caps
    // come through from `current` untouched.
    if (body.frozen !== undefined) {
      throw new HttpError(
        'invalid_request',
        'frozen is not a policy field; retire the wallet with DELETE, or freeze it on chain with admin-call',
      );
    }
    if (isUnreadable(current)) {
      // A PATCH MERGES ONTO WHAT IS THERE, and this service cannot read what is
      // there. Merging onto a fallback would silently discard whatever the
      // operator wrote; `{ clear: true }` is the operation that means throw it
      // away, and it works on an unreadable file precisely because it reads
      // nothing.
      throw new HttpError(
        'invalid_request',
        `policy file unreadable: ${current.unreadable}; clear it first`,
      );
    }
    const next = mergePolicy(body, current, this.chain.modules.tokens[0]?.key);

    // Also called here now. It was on this path only, so `POST /wallets` with
    // `deny: ["mark.play"]` was accepted while PATCH with the identical value
    // was refused - the same asymmetry in the other direction.
    await this.assertDenyEntriesAreCanonical(next.deny ?? []);

    // §3. `frozen` LEFT THIS BODY. The service-side lock is retirement, written
    // by `retire()` alone to its own table - so a PATCH can no longer freeze or
    // unfreeze, and freezing a LIVE wallet is the Token contract's, operated by
    // admin-call. A body carrying `frozen` is refused above rather than
    // ignored: an ignored field is one somebody wires up later.
    await this.writePolicyFile(agentId, next);
    return { agentId, ...next };
  }

  /// A deny entry must name a CANONICAL id or a PLATFORM name, never a vanity
  /// alias (chain spec S5's durable rule). The two are indistinguishable by
  /// shape - `treasury.play` and `mark.play` are the same string form - so the
  /// REGISTRY is the authority: an entry is canonical when it IS the primary
  /// name for the address it resolves to.
  ///
  /// Why the rule exists: a canonical entry is matched against the canonical
  /// that the transfer's own `to` resolution already produced, so it holds in
  /// every state the registry can be in. An alias-named entry depends on
  /// resolving the ENTRY itself, which is the read that can fail.
  ///
  /// An entry that resolves to nothing is ACCEPTED. It names no identity today,
  /// which is the same "not found is a legitimate no-match" rule the deny check
  /// itself uses - and refusing it would make a policy un-writable until the
  /// wallet it names exists, which inverts the spawn order.
  private async assertDenyEntriesAreCanonical(deny: string[]): Promise<void> {
    // WITHOUT A REGISTRY THERE ARE NO VANITY ALIASES, so there is nothing for
    // this rule to catch: it exists to stop a deny entry that resolves to
    // somebody else's canonical id today and to nobody's tomorrow. On a
    // names-less deployment `lookup` answers only exact spawned ids, so an
    // entry either IS a canonical id or names nothing - and running the check
    // would turn every deny entry into a store query for no decision.
    //
    // Deny entries are kept verbatim here, and §4.7 says what they then mean.
    if (this.chain.modules.names === undefined) return;

    for (const entry of deny) {
      if (entry.includes('*')) continue; // a pattern names no single identity
      const found = await this.resolver.lookup(entry).catch(() => null);
      if (!found) continue; // names nothing yet
      if (found.canonical && found.canonical !== entry) {
        throw new HttpError(
          'invalid_request',
          `deny entry ${JSON.stringify(entry)} is a vanity alias for ${found.canonical}; ` +
            `deny the canonical id or platform name instead, so the rule does not depend on ` +
            `resolving the alias at spend time`,
        );
      }
    }
  }

  /// The per-agent policy file wallet-mcp reads (spec S5). Written atomically:
  /// wallet-mcp may read it at any moment, and a half-written file would parse
  /// as a missing policy rather than as an error.
  /// `frozen` LEFT THE DOCUMENT at v0.8.0 (§3). Retirement writes its own
  /// table and never a policy file, so a `frozen` field here would be a value
  /// nothing writes and nothing reads - and wallet-mcp's local pre-check for it
  /// is gone for the same reason.
  private async writePolicyFile(agentId: string, caps: AgentPolicy): Promise<void> {
    const policy = { agentId, ...caps };
    await mkdir(this.config.policyDir, { recursive: true });
    const target = join(this.config.policyDir, keyFileName(agentId));
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(policy, null, 2), 'utf8');
    await rename(temp, target);
  }
}
