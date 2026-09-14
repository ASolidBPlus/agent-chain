// Wallet spawn, vanity aliases and retirement (spec S4).
//
// The identity rule this file exists to hold: a wallet is keyed by the
// QUALIFIED id `<org label>:<local id>`, composed by the caller from the game's
// org assignment and validated here. Nothing in this file reads a mesh alias, a
// message origin or a `from` field - those are observer-relative, and money
// keyed on them lands in the wrong account the first time a third mesh joins.

import { randomBytes } from 'node:crypto';
import { parseEther, type Address } from 'viem';
import { writeFile, rename, mkdir } from 'node:fs/promises';
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
import { mergePolicy, loadPolicyDefaults, readPolicyFile, isWalletKind, WALLET_KINDS,
  type AgentPolicy, type PolicyDefaults, type WalletKind,
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
  fundVee?: unknown;
  kind?: unknown;
  alias?: unknown;
  policy?: unknown;
}

export class Spawner {
  private readonly policyDefaults: PolicyDefaults;

  constructor(
    private readonly config: Config,
    private readonly chain: Chain,
    private readonly keystore: Keystore,
    private readonly store: Store,
    private readonly resolver: Resolver,
    policyDefaults?: PolicyDefaults,
  ) {
    this.policyDefaults = policyDefaults ?? loadPolicyDefaults(config.policyDefaultsPath);
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
    const fundVee = parseVee(body.fundVee ?? 0, 'fundVee');
    // hub-core may set per-agent caps; otherwise they come by kind from the
    // game-balance file, never from a constant in this module.
    // A supplied policy is a PATCH over the kind defaults, not a complete
    // document: `{allow, deny}` with the caps left alone is the harness's whole
    // use, and demanding all four made that the one shape that failed while
    // sending nothing succeeded.
    const policy = mergePolicy(body.policy, this.policyDefaults[kind]);

    // A burner is deliberately an unnamed address the game has to trace, so a
    // named burner is a contradiction rather than a request to be helpful about.
    if (kind === 'burner' && alias !== undefined) {
      throw new HttpError('invalid_request', 'a burner registers no names, so it cannot have an alias');
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
    await this.assertDenyEntriesAreCanonical(policy.deny);

    const address = (await this.keystore.has(agentId))
      ? (await this.keystore.load(agentId)).address
      : (await this.keystore.create(agentId)).address;

    await this.endowGas(address);
    if (fundVee > 0n) await this.fundVee(address, fundVee);
    if (kind !== 'burner') {
      await this.registerIfAbsent(agentId, address);
      if (alias) await this.registerIfAbsent(alias, address);
    }
    await this.writePolicyFile(agentId, policy, false);

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
    // Preserve whatever caps the wallet was spawned with: retirement freezes an
    // agent, it does not silently re-balance one. Falls back to the `agent`
    // defaults only when there is no file to preserve.
    await this.writePolicyFile(agentId, await this.existingPolicy(agentId), true);

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

  private async fundVee(address: Address, amount: bigint): Promise<void> {
    try {
      const balance = (await this.chain.publicClient.readContract({
        address: this.chain.deployment.VEEBux,
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
        address: this.chain.deployment.VEEBux,
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
        address: this.chain.deployment.NameRegistry,
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

  private async existingPolicy(agentId: string): Promise<AgentPolicy> {
    // Falls back to the `agent` defaults only when there is no file to preserve.
    return (await readPolicyFile(this.config.policyDir, agentId)) ?? this.policyDefaults.agent;
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
      max_per_tx?: unknown;
      max_per_stage?: unknown;
      allow?: unknown;
      deny?: unknown;
    },
  ): Promise<Record<string, unknown>> {
    assertCanonicalAgentId(agentId);
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
    const next = mergePolicy(body, current);

    // Also called here now. It was on this path only, so `POST /wallets` with
    // `deny: ["mark.vee"]` was accepted while PATCH with the identical value
    // was refused - the same asymmetry in the other direction.
    await this.assertDenyEntriesAreCanonical(next.deny);

    const frozen = typeof body.frozen === 'boolean' ? body.frozen : this.store.isFrozen(agentId);
    if (typeof body.frozen === 'boolean') {
      if (body.frozen) this.store.freeze(agentId);
      else this.store.unfreeze(agentId);
    }

    await this.writePolicyFile(agentId, next, frozen);
    return { agentId, ...next, frozen };
  }

  /// A deny entry must name a CANONICAL id or a PLATFORM name, never a vanity
  /// alias (chain spec S5's durable rule). The two are indistinguishable by
  /// shape - `treasury.vee` and `mark.vee` are the same string form - so the
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
  private async writePolicyFile(agentId: string, caps: AgentPolicy, frozen: boolean): Promise<void> {
    const policy = { agentId, ...caps, frozen };
    await mkdir(this.config.policyDir, { recursive: true });
    const target = join(this.config.policyDir, keyFileName(agentId));
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(policy, null, 2), 'utf8');
    await rename(temp, target);
  }
}
