// Money movement: treasury top-ups, agent-signed transfers, and history.
//
// Every destination is a NAME resolved through the registry - never an address
// a caller handed in, and never an id scraped off a mesh message. That is the
// whole of the addressing rule (spec S0/S5) and it lives here because this is
// the file that can move funds.

import { createWalletClient, encodeFunctionData, http, keccak256, toBytes, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomUUID } from 'node:crypto';
import { VEEBuxAbi } from './abi.ts';
import type { Chain } from './chain.ts';
import { asChainError } from './chain.ts';
import type { Config } from './config.ts';
import { HttpError } from './errors.ts';
import type { Keystore } from './keystore.ts';
import { resolveBareName } from './resolver.ts';
import type { Resolver, WalletResolution } from './resolver.ts';
import type { Store } from './store.ts';
import { walletPrincipal, type Principal } from './auth.ts';
import {
  enforcePolicy,
  readPolicyFile,
  stageCapWei,
  type AgentPolicy,
  type PolicyDefaults,
} from './policy.ts';
import { assertCanonicalAgentId, assertLookupName, formatVee, parseVee } from './validate.ts';

/// Which path a spend arrived by, for the `agent.spend` event.
///
/// THE MARKER IS A CLAIM, NOT A BOUNDARY (ruled 21:27 UTC). A persona holding
/// its own wallet token could send this header itself; nothing here stops it,
/// and nothing should. The boundary is the caps and the principal-derived
/// source, both enforced server-side. `via` is a purple-team signal for the
/// facilitator - a `direct` spend says something skipped the sanctioned path -
/// and must never be used as a control.
///
/// Stated the way it has to be read downstream (spec S5, 21:46 UTC): `via` is a
/// BEST-EFFORT DETECTION HINT, NEVER AN AUTHORISATION SIGNAL. A raw caller can
/// forge `via: "mcp"`, so treat `via: "direct"` as "worth investigating" and
/// never treat `via: "mcp"` as "cleared". The unspoofable fact is that an
/// agent.spend is emitted at all.
export function spendVia(marker?: string): 'mcp' | 'direct' {
  return marker !== undefined && marker.startsWith('wallet-mcp/') ? 'mcp' : 'direct';
}

/// The three operations signTransfer needs from a wallet client, named so the
/// prepare/sign/send split - which is where "provably before the broadcast"
/// stops being a phrase and becomes a boundary - is visible in the type.
/// THE ONE DERIVATION of a string intent id to the bytes32 the contract logs.
///
/// Used identically in three places - when chain-svc reserves the intent, when
/// it calls transferWithIntent, and when the sweep scans IntentTransfer for it.
/// Three derivations would give three answers to "did this land?", which is the
/// only question the event exists to answer, so this is deliberately the single
/// function and not an inline keccak at each site.
export function intentTopic(intentId: string): `0x${string}` {
  return keccak256(toBytes(intentId));
}

export interface Signer {
  prepareTransactionRequest: (a: Record<string, unknown>) => Promise<unknown>;
  signTransaction: (r: never) => Promise<`0x${string}`>;
  sendRawTransaction: (a: { serializedTransaction: `0x${string}` }) => Promise<`0x${string}`>;
}

export interface HistoryEntry {
  txHash: string;
  from: string;
  to: string;
  vee: string;
  blockNumber: string;
  memo?: string;
}

export class Treasury {
  /// hub-core's stage, cached briefly (spec S5). Only consulted when
  /// HUB_CORE_URL is configured; in the testbed the stage is chain-svc's own,
  /// set by platform-scope POST /stage, so the cap is testable before C5.
  private stageCache: { value: string; at: number } | null = null;

  constructor(
    private readonly config: Config,
    private readonly chain: Chain,
    private readonly keystore: Keystore,
    private readonly store: Store,
    private readonly resolver: Resolver,
    private readonly policyDefaults: PolicyDefaults,
  ) {}

  async currentStage(): Promise<string> {
    if (!this.config.hubCoreUrl) return this.store.currentStage();

    const fresh = this.stageCache && Date.now() - this.stageCache.at < 5_000;
    if (fresh) return this.stageCache!.value;

    try {
      const res = await fetch(new URL('/session', this.config.hubCoreUrl), {
        headers: { authorization: `Bearer ${this.config.token}` },
      });
      const body = (await res.json()) as { stage?: unknown };
      if (typeof body.stage === 'string' && body.stage !== '') {
        this.stageCache = { value: body.stage, at: Date.now() };
        return body.stage;
      }
    } catch {
      // hub-core being unreachable must not stop the game's money moving; the
      // locally-held stage is the fallback, and the cap still applies.
    }
    return this.store.currentStage();
  }

  /// The name-based check in `enforcePolicy` closes the common case - a deny
  /// naming the canonical, reached through an alias. It cannot close a deny
  /// naming ONE alias while the caller uses ANOTHER, because neither string
  /// matches the entry. This closes that by comparing IDENTITIES: each literal
  /// deny entry is resolved once and compared to the target's address.
  ///
  /// Resolving the DENY LIST rather than the target's aliases is deliberate.
  /// `resolver.aliasesOf` scans every `Registered` event from block 0, which
  /// would put a full log scan on every transfer and grow with the game. The
  /// deny list is one or two static entries, so this is O(deny) cached reads.
  ///
  /// Wildcard entries stay name-only - there is no address to resolve for
  /// `*.evil` - which is why the name check above is kept rather than replaced.
  private async assertNotDeniedByIdentity(
    policy: AgentPolicy,
    targetAddress: string,
    requested: string,
  ): Promise<void> {
    for (const entry of policy.deny) {
      if (entry.includes('*')) continue; // a pattern, already handled by name

      // RESOLVED EVERY TIME, NOT CACHED, and the cache this replaces was wrong
      // in a way my own comment two lines down used to argue against.
      //
      // It cached the not-found result permanently, reasoning that an
      // unregistered deny entry names no identity so the lookup need not be
      // repeated. But "not registered" is exactly as TRANSIENT as "read
      // failed": names get registered - that is what the game does. Deny a
      // counterparty by canonical id BEFORE that agent is spawned, spawn it,
      // and the null cached on the first send un-denies its aliases for the
      // life of the process. Ordinary sequencing, not an attack. The
      // distinction the cache drew was between two ERROR SHAPES, not between
      // two LIFETIMES.
      //
      // Caching the positive result is no safer: `setTargetFor` re-points a
      // name and retirement clears it, so a resolved address can go stale in
      // the other direction. THE PROPERTY IS THAT A DENY ENTRY'S RESOLUTION
      // MUST NOT OUTLIVE THE CONDITION IT WAS RESOLVED UNDER, and no TTL
      // expresses that - a TTL picks a window in which it may.
      //
      // The cost is one registry read per literal deny entry per send. Bounded
      // by the deny list, which is one or two entries, on a path that already
      // reads the registry for `to`. `policyFor` re-reads the policy file every
      // send for the same reason; a live policy over a frozen resolution was
      // the asymmetry that made this wrong.
      let address: string | null;
      try {
        address = (await this.resolver.lookup(entry))?.address.toLowerCase() ?? null;
      } catch (err) {
        // FAILS CLOSED on a transport error (ruled 05:29). NOT FOUND is an
        // answer - there is no such denied identity - and it is handled by
        // `address` being null below. READ FAILED is not an answer: admitting a
        // transfer we could not evaluate the deny list against errs in the one
        // direction a cap must never err in.
        //
        // This costs nothing in availability: `to` is always a NAME
        // (assertLookupName admits only a canonical id or an alias) and
        // `resolver.require` reads the registry for it earlier in this same
        // method, so a registry too broken to resolve a deny entry has already
        // refused the transfer.
        throw asChainError(err);
      }

      if (address && address === targetAddress.toLowerCase()) {
        throw new HttpError('counterparty_denied', `${requested} is not an allowed counterparty`);
      }
    }
  }

  /// The policy chain-svc ENFORCES is the same file it wrote for wallet-mcp to
  /// read, so the boundary and the model-facing fast path cannot drift apart.
  private async policyFor(agentId: string): Promise<AgentPolicy> {
    return (await readPolicyFile(this.config.policyDir, agentId)) ?? this.policyDefaults.agent;
  }

  /// Treasury -> wallet. Facilitator top-ups and bounty payouts (spec S4).
  ///
  /// Goes through the INTENT PATH like every other chain-svc transfer, with a
  /// server-generated id when the caller supplies none. Not tidiness: the
  /// sweep's negative branch reads "no IntentTransfer for this id therefore it
  /// did not land", and that inference is only sound if EMISSION IS UNIVERSAL.
  /// One silent transfer path and absence stops meaning anything, so the sweep
  /// could only ever confirm and never release, and holds would accumulate.
  ///
  /// It takes NO CAP HOLD (ruled 04:05): the treasury has no stage cap, and a
  /// facilitator top-up refused as over_stage_cap mid-game would be a bad
  /// failure. This is the one place the reservation's two halves come apart -
  /// the intent record is taken, the budget is not.
  async fund(body: {
    to?: unknown;
    vee?: unknown;
    reason?: unknown;
    intentId?: unknown;
  }): Promise<{ txHash: string; intentId: string }> {
    const name = assertLookupName(body.to);
    const amount = parseVee(body.vee, 'vee');
    const target = await this.resolver.require(name);
    const intentId =
      typeof body.intentId === 'string' && body.intentId !== ''
        ? body.intentId
        : `chain-svc:${randomUUID()}`;

    try {
      const hash = await this.chain.walletClient.writeContract({
        account: this.chain.walletClient.account!,
        chain: this.chain.viemChain,
        address: this.chain.deployment.VEEBux,
        abi: VEEBuxAbi,
        functionName: 'transferWithIntent',
        args: [target.address, amount, intentTopic(intentId)],
      });
      await this.chain.publicClient.waitForTransactionReceipt({ hash });
      this.store.recordMemo({
        txHash: hash,
        memo: typeof body.reason === 'string' ? body.reason : null,
        intentId,
        fromAgentId: 'treasury',
      });
      return { txHash: hash, intentId };
    } catch (err) {
      throw asChainError(err);
    }
  }

  /// Set a wallet's balance to EXACTLY `vee` (arena spec S3). Platform scope.
  ///
  /// Below target it funds the difference from the treasury. Above target it
  /// SWEEPS the difference back, signed from that wallet's own key. Equal is a
  /// no-op with no transaction and no txHash - "already correct" is a result,
  /// not something to spend gas proving.
  ///
  /// A FROZEN WALLET CAN STILL BE SET, deliberately: an operator resetting a
  /// balance is not an agent spending. See sweepToTreasury for what that costs.
  async setBalance(
    agentId: string,
    body: { vee?: unknown; intentId?: unknown; reason?: unknown; to?: unknown },
  ): Promise<{ balance: string; txHash?: string; intentId?: string }> {
    assertCanonicalAgentId(agentId);
    // `to` IS NOT A PARAMETER OF THIS ENDPOINT and never becomes one by
    // accident: a body carrying it is refused rather than ignored. An ignored
    // field is one somebody wires up later; a refused one cannot be. The sweep
    // destination is the treasury and is read from the deployment.
    if (body.to !== undefined) {
      throw new HttpError(
        'invalid_request',
        'this endpoint has no destination: a sweep always returns to the treasury',
      );
    }

    const target = parseVee(body.vee, 'vee');
    const wallet = await this.resolver.require(agentId);
    const current = (await this.chain.publicClient.readContract({
      address: this.chain.deployment.VEEBux,
      abi: VEEBuxAbi,
      functionName: 'balanceOf',
      args: [wallet.address],
    })) as bigint;

    if (current === target) return { balance: formatVee(current) };

    const reason = typeof body.reason === 'string' ? body.reason : null;
    const suppliedId = typeof body.intentId === 'string' && body.intentId !== '';
    const intentId = suppliedId ? (body.intentId as string) : `chain-svc:${randomUUID()}`;

    // IDEMPOTENT ON THE CALLER'S intentId, through the same reservation the
    // agent path uses - with NO CAP HOLD, because this is platform scope and
    // the treasury has no stage cap. A replay returns the original transaction
    // rather than moving money a second time.
    //
    // The ON-CHAIN half of the intent story (transferWithIntent /
    // IntentTransfer) is not on this branch: it is the contract PR, which now
    // sequences AFTER this one. So these transfers are recorded as intents in
    // the store and emit the ordinary Transfer, and the contract PR switches
    // this call site along with fund's and sign-transfer's. Flagged rather than
    // silently deferred, because "every chain-svc transfer emits an
    // IntentTransfer" is the premise the sweep's negative branch rests on, and
    // it is not true until that PR lands.
    const reservation = this.store.reserve({
      intentId,
      agentId,
      stage: await this.currentStage(),
      amount: current < target ? target - current : current - target,
      capWei: null,
      idSource: suppliedId ? 'caller' : 'server',
    });
    if (reservation.outcome === 'duplicate') {
      // Also measured rather than assumed: a replay reports what the wallet
      // holds now, which is the point of asking again.
      if (reservation.txHash) return { balance: formatVee(current), txHash: reservation.txHash, intentId };
      throw new HttpError(
        'intent_unresolved',
        `intent ${intentId} is reserved with no recorded transaction; reconcile before retrying`,
      );
    }

    const result =
      current < target
        // THE INTENT ID GOES THROUGH. `fund` gained the parameter in this PR
        // and `setBalance` is its only caller here; without this line a top-up
        // would record `intentId: null` while the sweep recorded the id - so a
        // top-up would be the one money movement whose intent cannot be joined
        // from /history, and BOTH SIDES WOULD COMPILE. Seat 2 recorded the
        // asymmetry against the pre-merge trees; this is where it dissolves.
        ? await this.fund({ to: agentId, vee: formatVee(target - current), reason, intentId })
        : await this.sweepToTreasury(agentId, current - target, reason, intentId);

    this.store.completeIntent(intentId, result.txHash);

    // RE-READ. The reply reported `target` at both exits, which is the
    // INTENTION and not the OUTCOME: `current` was read several awaits before
    // the transfer landed, so the number was never measured after the fact. It
    // is what the arena's Wallets panel shows, and a panel showing a number
    // nobody observed is the observer reporting its own state as the subject's.
    const settled = (await this.chain.publicClient.readContract({
      address: this.chain.deployment.VEEBux,
      abi: VEEBuxAbi,
      functionName: 'balanceOf',
      args: [wallet.address],
    })) as bigint;

    return { balance: formatVee(settled), txHash: result.txHash, intentId };
  }

  /// Wallet -> treasury, signed by chain-svc from that wallet's key under
  /// PLATFORM scope. This is a new power and worth being explicit about.
  ///
  /// Until this existed, `walletPrincipal` was the whole story: signing needed
  /// a WALLET credential whose id was the source, and platform scope could not
  /// spend from anybody. This can, and its containment is structural rather
  /// than intentional:
  ///
  ///   - THE DESTINATION IS NOT A PARAMETER. It is read from
  ///     `chain.deployment.treasury`. There is no code path here that accepts
  ///     one, so this cannot be turned into a transfer to a third party by a
  ///     caller, only by an edit to this function.
  ///   - No cap hold. The treasury has no stage cap and an operator reset
  ///     refused as `over_stage_cap` mid-game would be a bad failure.
  ///   - The intent record IS taken, so `fund` and this and `/sign-transfer`
  ///     all emit an IntentTransfer and absence of one keeps meaning something.
  ///
  /// AND ONE INVARIANT IT CHANGES, stated because a reviewer should meet it
  /// here rather than discover it: this does NOT go through `signTransfer`, so
  /// it skips the `isFrozen` check. `isFrozen` therefore stops being the single
  /// gate every outbound transfer passes. That is intended - freezing stops an
  /// AGENT spending, not an operator resetting - but it is no longer true that
  /// "nothing leaves a frozen wallet".
  private async sweepToTreasury(
    agentId: string,
    amount: bigint,
    reason: string | null,
    intentId: string,
  ): Promise<{ txHash: string }> {
    const { privateKey } = await this.keystore.load(agentId);
    const account = privateKeyToAccount(privateKey);
    const wallet = this.signerFor(account);

    try {
      // Plain `transfer` for now: `transferWithIntent` arrives with the
      // contract PR, which sequences after this one. The intent is recorded in
      // the store either way, so idempotency here does not wait on it.
      const data = encodeFunctionData({
        abi: VEEBuxAbi,
        functionName: 'transfer',
        args: [this.chain.deployment.treasury, amount],
      });
      const request = await wallet.prepareTransactionRequest({
        account,
        chain: this.chain.viemChain,
        to: this.chain.deployment.VEEBux,
        data,
      });
      const serialized = await wallet.signTransaction(request as never);
      const hash = await wallet.sendRawTransaction({ serializedTransaction: serialized });
      await this.chain.publicClient.waitForTransactionReceipt({ hash });

      this.store.recordMemo({ txHash: hash, memo: reason, intentId, fromAgentId: agentId });
      return { txHash: hash };
    } catch (err) {
      throw asChainError(err);
    }
  }

  /// Used only by wallet-mcp and org-core (spec S4). chain-svc holds the key;
  /// the caller never sees it.
  /// Wallet-scope `to` resolution plus the two instruments §5 requires, kept
  /// together because they must not drift apart: what resolves, what gets
  /// counted, and what gets signalled are one decision.
  private async resolveTo(name: string, fromAgentId: string): Promise<WalletResolution> {
    // Exactly one colon, guaranteed by CANONICAL_ID at every entry point, so
    // this is total rather than merely usual.
    const namespace = fromAgentId.slice(0, fromAgentId.indexOf(':'));
    try {
      // The free function with THIS resolver's lookup, so a caller holding
      // only a lookup runs the same code rather than a copy of it.
      const resolved = await resolveBareName((n) => this.resolver.lookup(n), name, namespace);
      // Counted on any BARE `to` that was not an exact hit - whether the
      // fallback then succeeded or not. See Store.countBareId.
      if (resolved.bare && resolved.resolvedVia === 'own_namespace') {
        this.countAndSignalBareId(fromAgentId, name, 'own_namespace');
      }
      return resolved;
    } catch (err) {
      if (err instanceof HttpError && err.code === 'ambiguous_name') {
        // SIGNALLED, NOT COUNTED. The bare form IS an exactly registered name
        // here, so the counter must not move - and folding it in would put two
        // meanings in one number, re-merging what §4's repeat_emission /
        // foreign_sender split keeps apart. The counter says "this persona
        // never learned the convention"; this event says "go and look at who
        // registered that alias", which is a different cause with a different
        // remediation.
        await this.signalCollision(name, fromAgentId);
      } else if (err instanceof HttpError && err.code === 'unknown_name' && !name.includes(':')) {
        // A bare miss is the untaught form too - it is what `unknown_name` was
        // detecting before §5, and it must keep firing.
        this.countAndSignalBareId(fromAgentId, name, 'unresolved');
      }
      throw err;
    }
  }

  /// Counts AND DELIVERS. The column is the durable count; the event is how it
  /// REACHES anyone.
  ///
  /// This was a counter with no reader - no route, no event, no consumer
  /// outside its own tests - while its sibling in the same change went out
  /// through `enqueueEvent`, the mechanism that exists for exactly this. The
  /// detector §5 traded `unknown_name` for would have ACCUMULATED IN A COLUMN
  /// instead of arriving, recoverable only by someone opening the store. A
  /// VALUE NOTHING SURFACES IS NOT YET A SIGNAL.
  ///
  /// Still count, don't accumulate (the 09:41 rule): the outbox DELIVERS and
  /// drains, so this adds no retention. The running total travels with each
  /// event so a facilitator sees the trend without querying anything.
  private countAndSignalBareId(
    agentId: string,
    to: string,
    outcome: 'own_namespace' | 'unresolved',
  ): void {
    this.store.countBareId(agentId);
    this.store.enqueueEvent('chain.bare_id', {
      kind: 'chain.bare_id',
      agentId,
      to,
      outcome,
      count: this.store.bareIdCount(agentId),
    });
  }

  /// The facilitator-visible half of the ambiguity refusal. Best effort: a
  /// failure to describe the collision must not change the REFUSAL, which has
  /// already been decided.
  private async signalCollision(bare: string, agentId: string): Promise<void> {
    const namespace = agentId.slice(0, agentId.indexOf(':'));

    // ENRICHMENT IS BEST-EFFORT; THE SIGNAL IS NOT. Wrapping the whole thing in
    // one catch loses the ALERT because a detail could not be fetched - and the
    // detail here is a second registry read, which is exactly the sort of thing
    // that fails on the day something odd is happening. A collision reported
    // without its registrant is still "go and look"; a collision not reported
    // at all is a squat nobody hears about.
    const detail = async <T>(read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read();
      } catch {
        return null;
      }
    };
    const alias = await detail(() => this.resolver.lookup(bare));
    const peer = await detail(() => this.resolver.lookup(`${namespace}:${bare}`));
    const registrant = await detail(() => this.resolver.registrantOf(bare));

    try {
      this.store.enqueueEvent('chain.name_collision', {
        kind: 'chain.name_collision',
        agentId,
        bare,
        candidates: [
          { alias: bare, canonical: alias?.canonical ?? null, address: alias?.address ?? null },
          { canonical: `${namespace}:${bare}`, address: peer?.address ?? null },
        ],
        registrant,
      });
    } catch {
      // The caller already has its 409. Losing the facilitator's copy must not
      // turn a refusal into a 502 - but this is now the ONLY thing swallowed,
      // rather than the whole signal.
    }
  }

  async signTransfer(
    principal: Principal,
    body: {
      fromAgentId?: unknown;
      to?: unknown;
      vee?: unknown;
      memo?: unknown;
      intentId?: unknown;
    },
    /// The X-Wallet-Client header, when the caller sent one.
    clientMarker?: string,
  ): Promise<{
    txHash: string;
    intentId: string;
    intentIdSource: 'caller' | 'server';
    /// WHO was paid, as the registry knows them - so a persona can see whom it
    /// actually paid rather than the string it typed.
    canonical: string | null;
    /// WHICH RULE resolved it (§5). `canonical` alone would leave a correct
    /// bare id and a wrong name that happens to resolve looking identical.
    resolvedVia: 'exact' | 'own_namespace';
  }> {
    // The source is DERIVED from the credential, never read from the body. A
    // body fromAgentId is tolerated only when it agrees; disagreeing is a 403
    // rather than a silent override, so a caller that lies is told so.
    const fromAgentId = walletPrincipal(principal, body.fromAgentId);
    const name = assertLookupName(body.to);
    const amount = parseVee(body.vee, 'vee');

    // The store is the single truth for frozen (spec S4); the per-agent policy
    // file is only wallet-mcp's local fast-path copy, and loses any disagreement.
    if (this.store.isFrozen(fromAgentId)) {
      throw new HttpError('wallet_frozen', `${fromAgentId} is frozen`);
    }

    // Caps are a BOUNDARY here, not just game balance (ruled 20:57). The same
    // checks exist in wallet-mcp for the model-facing message, but wallet-mcp
    // runs inside a persona designed to be socially engineered, so a check that
    // lives only there is bypassed by calling this endpoint directly.
    const stage = await this.currentStage();
    const policy = await this.policyFor(fromAgentId);
    // RESOLVE FIRST. The policy check needs the registry's primary name for the
    // address, not just the string the caller typed - see enforcePolicy.
    //
    // WALLET-SCOPE resolution: a bare `to` may name a peer in the CALLER'S OWN
    // namespace (§5). The namespace is derived from `fromAgentId`, which is
    // itself derived from the credential a few lines above and never from the
    // body - so the fallback cannot be steered by the request.
    const target = await this.resolveTo(name, fromAgentId);
    enforcePolicy({ policy, to: name, canonical: target.canonical ?? undefined, amount });
    await this.assertNotDeniedByIdentity(policy, target.address, name);
    const { privateKey } = await this.keystore.load(fromAgentId);

    // A caller that supplies no intent id gets a fresh one rather than a
    // different code path: every send is reserved the same way, and a caller
    // that wants its retry deduped is the one that has to name it.
    //
    // But a caller that simply FORGOT the field would otherwise lose
    // idempotency silently, so the generated id is returned to it and logged.
    // A degradation nobody can see is one nobody fixes.
    const supplied = typeof body.intentId === 'string' && body.intentId !== '';
    const source = supplied ? ('caller' as const) : ('server' as const);
    const intentId = supplied ? (body.intentId as string) : `chain-svc:${randomUUID()}`;
    if (!supplied) {
      console.warn(
        `[chain-svc] sign-transfer for ${fromAgentId} carried no intentId; generated ${intentId}. ` +
          `This send is NOT deduplicated against a retry - supply intentId to make it so.`,
      );
    }

    // ONE reservation covering BOTH the stage cap and the intent, taken BEFORE
    // the money moves. These used to be separate and both wrong in the same
    // way - a decision and its durable record were not one operation - so the
    // cap was check-then-act (concurrent sends all read the same pre-spend
    // total) and the intent was act-then-record (a dropped response made the
    // correct retry a second real transfer, because VEEBux is a plain ERC-20
    // and a second identical transfer is a valid second transfer).
    const reservation = this.store.reserve({
      intentId,
      topic: intentTopic(intentId),
      // NO CURRENT CONSUMER. Stamped here because the reserve-time head is
      // IRRECOVERABLE LATER; the sweep does not read it. See the
      // `reservedAtBlock` comment on Store.reserve for why it is kept.
      //
      // NO RPC FALLBACK, deliberately. Reading the head here would put a chain
      // call on the money path for every send, for a column on the money path
      // that no code path consumes. When the tail has not polled yet this is
      // null, and the future consumer must read null as "cannot bound".
      reservedAtBlock: this.store.observedHead() ?? undefined,
      idSource: source,
      agentId: fromAgentId,
      stage,
      amount,
      capWei: stageCapWei(policy),
    });

    if (reservation.outcome === 'over_stage_cap') {
      throw new HttpError('over_stage_cap', `max_per_stage is ${policy.max_per_stage} VEE for this stage`);
    }
    if (reservation.outcome === 'duplicate') {
      // The promise wallet-mcp makes to the model: a replay of the same send
      // returns the ORIGINAL result. Answering with the recorded hash is what
      // makes a retry safe.
      if (reservation.txHash) {
        return {
          txHash: reservation.txHash, intentId, intentIdSource: source,
          canonical: target.canonical, resolvedVia: target.resolvedVia,
        };
      }
      // Reserved but never completed: the first attempt reached the broadcast
      // and we do not know its outcome. Re-sending here is precisely the
      // double-charge, so this refuses and says why. It is an operator's job
      // to reconcile against the chain, not this handler's to guess.
      throw new HttpError(
        'intent_unresolved',
        `intent ${intentId} is reserved with no recorded transaction: an earlier attempt reached ` +
          `the broadcast and its outcome is unknown. Reconcile against the chain using THIS intent ` +
          `id - never retry with a fresh one, which would send a second time.`,
      );
    }

    // --- PROVABLY BEFORE THE BROADCAST ------------------------------------
    // Building the client is local, and prepare (nonce, fees) reads while sign
    // is local; none of them can put a transaction on the wire. A failure here
    // therefore provably precedes the broadcast, and this is the ONLY thing in
    // this method that may release. It sits AFTER the reservation so that a
    // replay is answered without loading a key or opening a connection.
    let serializedTransaction: `0x${string}`;
    let wallet: Signer;
    try {
      const account = privateKeyToAccount(privateKey);
      wallet = this.signerFor(account);
      const data = encodeFunctionData({
        abi: VEEBuxAbi,
        functionName: 'transferWithIntent',
        args: [target.address, amount, intentTopic(intentId)],
      });
      const request = await wallet.prepareTransactionRequest({
        account,
        chain: this.chain.viemChain,
        to: this.chain.deployment.VEEBux,
        data,
      });
      serializedTransaction = await wallet.signTransaction(request as never);
    } catch (err) {
      this.store.release(intentId);
      throw asChainError(err);
    }

    // --- AT OR AFTER THE BROADCAST ----------------------------------------
    // From here the reservation STANDS whatever happens, including a timeout,
    // a dropped response, or this process dying: none of those distinguish
    // "it never landed" from "it landed and we did not hear". Keeping the
    // reservation makes the retry idempotent and leaves an operator a row to
    // reconcile; releasing it would hand back a budget that may already be
    // spent and re-authorise a transfer that already happened.
    const sent = await this.broadcast({
      wallet,
      serializedTransaction,
      intentId,
      fromAgentId,
      to: name,
      amount,
      via: spendVia(clientMarker),
      memo: body.memo,
    });
    return {
      ...sent, intentId, intentIdSource: source,
      canonical: target.canonical, resolvedVia: target.resolvedVia,
    };
  }

  /// The wallet client, as a seam. Overridable ONLY so a test can drive the
  /// whole of signTransfer without a chain - which matters because the defect
  /// this method's ordering exists to prevent was never in the reservation
  /// primitive, it was in the ORDER here, and a test that drives the primitive
  /// directly stays green when the order changes.
  protected signerFor(account: ReturnType<typeof privateKeyToAccount>): Signer {
    // Same 50ms polling as the shared clients: viem's 4s default turns an
    // instant-mined transfer into a four-second request. See chain.ts.
    return createWalletClient({
      account,
      chain: this.chain.viemChain,
      transport: http(this.config.rpcUrl),
      pollingInterval: 50,
    }) as unknown as Signer;
  }

  /// The post-broadcast tail, extracted so that the release rule above has
  /// exactly one catch to live in and this one cannot quietly grow a second.
  private async broadcast(args: {
    wallet: Pick<Signer, 'sendRawTransaction'>;
    serializedTransaction: `0x${string}`;
    intentId: string;
    fromAgentId: string;
    to: string;
    amount: bigint;
    via: string;
    memo: unknown;
  }): Promise<{ txHash: string }> {
    try {
      const hash = await args.wallet.sendRawTransaction({
        serializedTransaction: args.serializedTransaction,
      });
      // Recorded as soon as there IS a hash, before the receipt: a crash while
      // waiting must still leave the retry able to find the original send.
      this.store.completeIntent(args.intentId, hash);
      await this.chain.publicClient.waitForTransactionReceipt({ hash });

      // The memo has no on-chain home - ERC-20 transfer carries none - so it is
      // joined back on by txHash in /history (spec S4).
      this.store.recordMemo({
        txHash: hash,
        memo: typeof args.memo === 'string' ? args.memo : null,
        intentId: args.intentId,
        fromAgentId: args.fromAgentId,
      });
      // The stage budget was consumed by the RESERVATION, before the send --
      // it is not added here. It used to be, and that was the defect: a
      // decision recorded after the act it authorised.

      // `agent.spend` shows WHO DECIDED, where `chain.transfer` from the log
      // tail only shows what moved (spec S5). Emitted here rather than in
      // wallet-mcp (ruled 21:27 UTC) so that money can never move without one:
      // wallet-mcp runs inside the persona, and a persona calling this endpoint
      // directly would otherwise produce a transfer with nobody deciding it.
      //
      // `via` preserves the tell that moving the emitter would have cost; see
      // spendVia for why it is a claim rather than a boundary.
      this.store.enqueueEvent('agent.spend', {
        kind: 'agent.spend',
        name: args.fromAgentId,
        to: args.to,
        vee: formatVee(args.amount),
        intent_id: args.intentId,
        via: args.via,
        txHash: hash,
      });
      return { txHash: hash };
    } catch (err) {
      // Deliberately NOT a release. See the rule above.
      throw asChainError(err);
    }
  }

  /// Transfer logs touching this wallet, newest first, names resolved where
  /// known (spec S4).
  async history(name: string, limit: number): Promise<HistoryEntry[]> {
    const who = await this.resolver.require(assertLookupName(name));

    let logs;
    try {
      const [sent, received] = await Promise.all([
        this.chain.publicClient.getContractEvents({
          address: this.chain.deployment.VEEBux,
          abi: VEEBuxAbi,
          eventName: 'Transfer',
          args: { from: who.address },
          fromBlock: 0n,
          toBlock: 'latest',
        }),
        this.chain.publicClient.getContractEvents({
          address: this.chain.deployment.VEEBux,
          abi: VEEBuxAbi,
          eventName: 'Transfer',
          args: { to: who.address },
          fromBlock: 0n,
          toBlock: 'latest',
        }),
      ]);
      logs = [...sent, ...received];
    } catch (err) {
      throw asChainError(err);
    }

    logs.sort((a, b) => Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)));
    const window = logs.slice(0, limit);

    const memos = this.store.memosFor(window.map((l) => l.transactionHash ?? ''));
    const nameCache = new Map<string, string>();
    const nameFor = async (address: Address): Promise<string> => {
      const key = address.toLowerCase();
      const cached = nameCache.get(key);
      if (cached !== undefined) return cached;
      const canonical = (await this.resolver.reverseOf(address)) ?? address;
      nameCache.set(key, canonical);
      return canonical;
    };

    const out: HistoryEntry[] = [];
    for (const log of window) {
      const args = log.args as { from?: Address; to?: Address; value?: bigint };
      if (!args.from || !args.to || args.value === undefined) continue;
      const txHash = log.transactionHash ?? '';
      const memo = memos.get(txHash.toLowerCase())?.memo ?? undefined;
      out.push({
        txHash,
        from: await nameFor(args.from),
        to: await nameFor(args.to),
        vee: formatVee(args.value),
        blockNumber: String(log.blockNumber ?? 0n),
        ...(memo ? { memo } : {}),
      });
    }
    return out;
  }
}
