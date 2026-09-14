// Money movement: treasury top-ups, agent-signed transfers, and history.
//
// Every destination is a NAME resolved through the registry - never an address
// a caller handed in, and never an id scraped off a mesh message. That is the
// whole of the addressing rule (spec S0/S5) and it lives here because this is
// the file that can move funds.

import {
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  toBytes,
  type AbiFunction,
  type AbiParameter,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createHash, randomUUID } from 'node:crypto';
import { TokenAbi } from './abi.ts';
import { validateArgs, type EncodableArg, type WireAddress } from './callargs.ts';
import type { Allowlist, CallEntry, CallPolicySource } from './calls.ts';
import type { Chain } from './chain.ts';
import { asChainError, ZERO_FEES } from './chain.ts';
import type { Config } from './config.ts';
import { HttpError } from './errors.ts';
import type { Keystore } from './keystore.ts';
import { resolveBareName, ownNamespaceCandidate } from './resolver.ts';
import type { Resolver, WalletResolution } from './resolver.ts';
import type { Store } from './store.ts';
import { walletPrincipal, type Principal } from './auth.ts';
import {
  capsFor,
  enforcePolicy,
  readPolicyFile,
  stageCapWei,
  type AgentPolicy,
  type PolicyDefaults,
} from './policy.ts';
import { assertCanonicalAgentId, assertLookupName, formatVee, parseVee } from './validate.ts';
import {
  defaultToken,
  requireContract,
  resolveToken,
  type RegisteredContract,
  type TokenModule,
} from './modules.ts';

/// §3.4. A serialised read result over this is REFUSED rather than truncated:
/// a view returning an unbounded array is a contract design problem, and a
/// truncated answer hides it behind a result that looks complete.
const MAX_READ_BYTES = 64 * 1024;

/// A contract's return value, as JSON a model can read.
///
/// EVERY LOSSY TYPE IS CONVERTED AT ITS OWN LEVEL rather than by a JSON
/// replacer at the top: a bigint has no JSON form, an address has a canonical
/// spelling that is not the one the chain returns, and a struct arrives from
/// viem as an object keyed by component name already. Recursion is what makes
/// a tuple inside an array inside a struct come out right.
export function serialiseResult(value: unknown, fn: AbiFunction): unknown {
  const outputs = fn.outputs as readonly AbiParameter[];
  // A function with one return value returns THE VALUE, not a one-element
  // list: `quote(...)` answering `["40"]` would make every caller index into
  // it, and viem's own shape is the reason - it returns the bare value.
  if (outputs.length === 1) return serialiseOne(value, outputs[0]!);

  // SEVERAL RETURN VALUES, KEYED BY NAME WHEN THEY HAVE ONE. viem hands these
  // back as a positional array, which is how the Converter's
  // `pair() -> (rate, paused, exists)` reached a persona as
  // `["750000000000000000", false, true]` - three values it cannot tell apart,
  // and a bool pair it cannot tell apart AT ALL. Found by the compose smoke,
  // whose own expectation is "→ rate 750000000000000000".
  //
  // Positional only when a name is missing, because there is then nothing to
  // key on and an invented index would be a worse lie than the array.
  const named = outputs.every((o) => (o.name ?? '') !== '');
  const list = (value as unknown[]).map((v, i) => serialiseOne(v, outputs[i]!));
  if (!named) return list;
  return Object.fromEntries(outputs.map((o, i) => [o.name!, list[i]]));
}

function serialiseOne(value: unknown, param: AbiParameter): unknown {
  const type = param.type;
  const array = /^(.*)\[\d*\]$/.exec(type);
  if (array) {
    return (value as unknown[]).map((v) => serialiseOne(v, { ...param, type: array[1]! } as AbiParameter));
  }
  if (type === 'tuple') {
    const components = (param as { components?: readonly AbiParameter[] }).components ?? [];
    const out: Record<string, unknown> = {};
    for (const c of components) {
      out[c.name ?? ''] = serialiseOne((value as Record<string, unknown>)[c.name ?? ''], c);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  // CHECKSUMMED, because that is the spelling every other address on these
  // wires carries and a reader comparing two of them should not have to
  // normalise first.
  if (type === 'address' && typeof value === 'string') return getAddress(value);
  return value;
}

/// Which path a spend arrived by, for the `agent.spend` event.
///
/// THE MARKER IS A CLAIM, NOT A BOUNDARY (ruled). A persona holding
/// its own wallet token could send this header itself; nothing here stops it,
/// and nothing should. The boundary is the caps and the principal-derived
/// source, both enforced server-side. `via` is a purple-team signal for the
/// facilitator - a `direct` spend says something skipped the sanctioned path -
/// and must never be used as a control.
///
/// Stated the way it has to be read downstream (spec S5): `via` is a
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
  /// The amount, in the named token's own whole units.
  amount: string;
  /// The same value under its old name, until v0.6.0.
  vee: string;
  /// The token's SYMBOL - what a persona reads and can write back. The KEY is
  /// what chain-svc stores; `resolveToken` is the one place they meet.
  token: string;
  blockNumber: string;
  memo?: string;
}

/// Deny entries already reported as unresolvable, so the line is printed once
/// per distinct entry per process rather than once per send. Module-level
/// because the lifetime is the PROCESS, not a Treasury instance - and EXPORTED
/// for the same reason `droppedPatternsLogged` is: a test asserting a
/// once-per-process property has to own the process state, or it passes alone
/// and fails beside another file that consumed the first occurrence.
export const skippedDenyEntriesLogged = new Set<string>();

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
    /// The generic call op's allowlist. Read per request through `snapshot()`,
    /// never held: the file is hub-set and may be rewritten between turns.
    private readonly calls: CallPolicySource,
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
        // FAILS CLOSED on a transport error (ruled). NOT FOUND is an
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

      if (address === null) {
        // UNRESOLVABLE, which means two different things and only one of them
        // is worth saying out loud.
        //
        // WITH a registry: the entry names nobody YET. Ordinary - deny a
        // counterparty before it is spawned and this is the state until it is -
        // so it is silent, and the re-resolution above is what picks it up
        // later.
        //
        // WITHOUT one: `lookup` answers only exact spawned ids, so an entry
        // that is a NAME can never resolve and the rule can never bind. That is
        // worth one line, because a deny list is a safety expectation and an
        // operator should not have to infer that part of theirs is inert.
        //
        // Entry-keyed and once per process. Not per agent: on a names-less
        // deployment every agent without its own policy file inherits the
        // defaults, so an agent-keyed set would print the same fact once per
        // wallet. Not per send: `policyFor` re-reads the file every send by
        // design. Once per process is the signal; once ever would need a store
        // row, and a configuration oddity does not earn one.
        if (this.chain.modules.names === undefined && !skippedDenyEntriesLogged.has(entry)) {
          skippedDenyEntriesLogged.add(entry);
          console.warn(
            `[chain-svc] deny entry ${JSON.stringify(entry)} cannot be resolved on a deployment ` +
              `with no names module, so it is skipped. Nothing here can be addressed by name; ` +
              `deny entries that are agent ids still bind.`,
          );
        }
        continue;
      }

      if (address === targetAddress.toLowerCase()) {
        throw new HttpError('counterparty_denied', `${requested} is not an allowed counterparty`);
      }
    }
  }

  /// The policy chain-svc ENFORCES is the same file it wrote for wallet-mcp to
  /// read, so the boundary and the model-facing fast path cannot drift apart.
  private async policyFor(agentId: string): Promise<AgentPolicy> {
    const key = this.chain.modules.tokens[0]?.key;
    return (await readPolicyFile(this.config.policyDir, agentId, key)) ?? this.policyDefaults.agent;
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
  /// It takes NO CAP HOLD (ruled): the treasury has no stage cap, and a
  /// facilitator top-up refused as over_stage_cap mid-game would be a bad
  /// failure. This is the one place the reservation's two halves come apart -
  /// the intent record is taken, the budget is not.
  async fund(body: {
    to?: unknown;
    amount?: unknown;
    token?: unknown;
    reason?: unknown;
    intentId?: unknown;
  }): Promise<{ txHash: string; intentId: string }> {
    const name = assertLookupName(body.to);
    // ONE RESOLVE, CARRIED. `fund` acts on the NAMED TOKEN ONLY, leaving every
    // other balance untouched - so its address, its decimals and its symbol all
    // come off this one value.
    const tok = resolveToken(this.chain.modules, body.token);
    const amount = parseVee(body.amount, tok.decimals, tok.symbol, 'amount');
    const target = await this.resolver.require(name);
    const intentId =
      typeof body.intentId === 'string' && body.intentId !== ''
        ? body.intentId
        : `chain-svc:${randomUUID()}`;

    // §1. A SHORT TREASURY IS REFUSED BY NAME, before the transfer.
    //
    // Without this the shortfall arrives as whatever the token contract says -
    // a raw revert, classified `revert`, reading to an operator as "the call
    // was mined and reverted; nothing changed". True, and useless: it names no
    // cause and suggests no remedy, and the remedy is specific (mint to the
    // treasury) and is the operator's to perform.
    //
    // CHECKED AGAINST THE SAME RESOLVED TOKEN the transfer uses, not looked up
    // again: read and write are two uses of one resolution, and sourcing them
    // separately is what lets a check measure one token's float and a transfer
    // move another's.
    //
    // This is a check, not a lock. Two concurrent funds can both pass it and
    // the second still revert on-chain - which is correct: the chain is the
    // authority on the balance and this only turns the COMMON case into a
    // refusal that names its cause.
    try {
      const float = (await this.chain.publicClient.readContract({
        address: tok.address,
        abi: TokenAbi,
        functionName: 'balanceOf',
        // `chain.treasury` (the account that SIGNS) rather than
        // `deployment.treasury` (what the manifest declares). The constructor
        // refuses to start unless they agree, so today they cannot differ - but
        // the question this asks is "can the sender cover it", and the sender is
        // the wallet client's account. Reading the declared address would be
        // right by coincidence rather than by construction.
        args: [this.chain.treasury],
      })) as bigint;
      if (float < amount) {
        throw new HttpError(
          'treasury_insufficient',
          `the treasury holds ${formatVee(float, tok.decimals)} ${tok.symbol} and this moves ` +
            `${formatVee(amount, tok.decimals)}; mint to the treasury with ` +
            `admin-call ${tok.key}.mint`,
        );
      }
    } catch (err) {
      // The REFUSAL passes through as itself; only a chain failure is
      // reclassified. Without the instanceof the refusal would be wrapped as a
      // chain_error by its own read's catch - a check reporting itself broken.
      if (err instanceof HttpError) throw err;
      throw asChainError(err);
    }

    try {
      const hash = await this.chain.walletClient.writeContract({
        account: this.chain.walletClient.account!,
        chain: this.chain.viemChain,
        address: tok.address,
        abi: TokenAbi,
        functionName: 'transferWithIntent',
        args: [target.address, amount, intentTopic(intentId)],
        ...ZERO_FEES,
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

  /// Set a wallet's balance to EXACTLY `vee` (harness spec S3). Platform scope.
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
    body: {
      /// The target balance, in the named token's own whole units.
      amount?: unknown;
      /// Which token's balance to set. Absent means the default token; the
      /// others are left exactly as they were.
      token?: unknown;
      intentId?: unknown;
      reason?: unknown;
      to?: unknown;
    },
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

    // ONE RESOLVE, CARRIED into the balance read, the top-up, the sweep and the
    // re-read below. `set-balance` acts on the NAMED TOKEN ONLY, leaving every
    // other balance untouched - so a second lookup anywhere here would set one
    // token's balance by measuring another's.
    const tok = resolveToken(this.chain.modules, body.token);
    const target = parseVee(body.amount, tok.decimals, tok.symbol, 'amount');
    const wallet = await this.resolver.require(agentId);
    const current = (await this.chain.publicClient.readContract({
      address: tok.address,
      abi: TokenAbi,
      functionName: 'balanceOf',
      args: [wallet.address],
    })) as bigint;

    if (current === target) return { balance: formatVee(current, tok.decimals) };

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
      token: tok.key,
      idSource: suppliedId ? 'caller' : 'server',
    });
    if (reservation.outcome === 'duplicate') {
      // Also measured rather than assumed: a replay reports what the wallet
      // holds now, which is the point of asking again.
      if (reservation.txHash) return { balance: formatVee(current, tok.decimals), txHash: reservation.txHash, intentId };
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
        // from /history, and BOTH SIDES WOULD COMPILE. Review recorded the
        // asymmetry against the pre-merge trees; this is where it dissolves.
        ? await this.fund({
            to: agentId,
            amount: formatVee(target - current, tok.decimals),
            // THE SAME TOKEN, passed on rather than defaulted inside `fund`.
            // Without it a set-balance of GOLD would top up in PLAY and then
            // re-read GOLD, and the reply would report a number nobody moved.
            token: tok.key,
            reason,
            intentId,
          })
        : await this.sweepToTreasury(agentId, current - target, reason, intentId, tok);

    this.store.completeIntent(intentId, result.txHash);

    // RE-READ. The reply reported `target` at both exits, which is the
    // INTENTION and not the OUTCOME: `current` was read several awaits before
    // the transfer landed, so the number was never measured after the fact. It
    // is what the harness's Wallets panel shows, and a panel showing a number
    // nobody observed is the observer reporting its own state as the subject's.
    const settled = (await this.chain.publicClient.readContract({
      address: tok.address,
      abi: TokenAbi,
      functionName: 'balanceOf',
      args: [wallet.address],
    })) as bigint;

    return { balance: formatVee(settled, tok.decimals), txHash: result.txHash, intentId };
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
    /// THE RESOLVED TOKEN to sweep. Passed rather than defaulted, because
    /// `set-balance` names its token and the sweep is the OTHER half of the
    /// same operation: a GOLD set-balance that needs to sweep would otherwise
    /// take PLAY out of the wallet, leaving the gold balance exactly as it was
    /// and the reply reporting a number nobody moved.
    token: TokenModule,
  ): Promise<{ txHash: string }> {
    const { privateKey } = await this.keystore.load(agentId);
    const account = privateKeyToAccount(privateKey);
    const wallet = this.signerFor(account);

    try {
      // Plain `transfer` for now: `transferWithIntent` arrives with the
      // contract PR, which sequences after this one. The intent is recorded in
      // the store either way, so idempotency here does not wait on it.
      const data = encodeFunctionData({
        abi: TokenAbi,
        functionName: 'transfer',
        args: [this.chain.deployment.treasury, amount],
      });
      const request = await wallet.prepareTransactionRequest({
        account,
        chain: this.chain.viemChain,
        to: token.address,
        data,
        ...ZERO_FEES,
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
        //
        // TWO WORLDS, NOT ONE. Both reach `unknown_name`, and they are different
        // facts about the persona: `shape_skipped` means the bare form could
        // never be a local id (a mixed-case `aIpha`), so the fallback was never
        // tried; `unknown` means it was tried and nobody holds that name. The
        // first says the persona typed something that cannot be an id at all;
        // the second says it named a wallet that does not exist.
        //
        // Classified through `ownNamespaceCandidate` - the same function the
        // resolver uses to decide - so the label cannot disagree with what
        // actually happened.
        const outcome = ownNamespaceCandidate(namespace, name) === null ? 'shape_skipped' : 'unknown';
        this.countAndSignalBareId(fromAgentId, name, outcome);
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
  /// Still count, don't accumulate (the retention rule): the outbox DELIVERS and
  /// drains, so this adds no retention. The running total travels with each
  /// event so a facilitator sees the trend without querying anything.
  private countAndSignalBareId(
    agentId: string,
    bare: string,
    outcome: 'own_namespace' | 'shape_skipped' | 'unknown',
  ): void {
    this.store.countBareId(agentId);
    this.store.enqueueEvent('chain.bare_id', {
      kind: 'chain.bare_id',
      agentId,
      bare,
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
      /// The amount, in the named token's own whole units. `vee` is aliased to
      /// this by `readBody` for one release, so nothing here reads `vee`.
      amount?: unknown;
      /// The token's KEY or its SYMBOL, case-insensitively; absent means the
      /// default token, which is the increment's one rule.
      token?: unknown;
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
    // ONE RESOLVE, ONE VALUE, CARRIED. `tok` is the token this transfer is in
    // from here to the broadcast: its decimals parse the amount, its symbol
    // appears in every refusal, its key is the caps and bookkeeping coordinate,
    // and its address is the contract the transfer is sent to. Five uses of one
    // fact - and sourcing any of them from a second lookup is what lets one of
    // them belong to a different token while the rest look right.
    const tok = resolveToken(this.chain.modules, body.token);
    const amount = parseVee(body.amount, tok.decimals, tok.symbol, 'amount');

    // The store is the single truth for frozen (spec S4); the per-agent policy
    // file is only wallet-mcp's local fast-path copy, and loses any disagreement.
    if (this.store.isFrozen(fromAgentId)) {
      throw new HttpError('wallet_frozen', `${fromAgentId} is frozen`);
    }

    // Caps are a BOUNDARY here, not just game balance (ruled). The same
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
    const { decimals, symbol } = tok;
    enforcePolicy({
      policy,
      to: name,
      canonical: target.canonical ?? undefined,
      amount,
      decimals,
      symbol,
      tokenKey: tok.key,
    });
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
    // correct retry a second real transfer, because the token is a plain ERC-20
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
      // The SAME token the amount was parsed at and the cap is read against, so
      // the hold and the bound it is tested against cannot be in different
      // currencies.
      token: tok.key,
      capWei: stageCapWei(policy, tok.key, decimals),
    });

    if (reservation.outcome === 'over_stage_cap') {
      throw new HttpError(
        'over_stage_cap',
        `max_per_stage is ${capsFor(policy, tok.key).max_per_stage} ` +
          `${symbol} for this stage`,
      );
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
        abi: TokenAbi,
        functionName: 'transferWithIntent',
        args: [target.address, amount, intentTopic(intentId)],
      });
      const request = await wallet.prepareTransactionRequest({
        account,
        chain: this.chain.viemChain,
        // THE RESOLVED TOKEN'S OWN CONTRACT. The last of the five uses of one
        // fact, and the one that would move real money to the wrong ledger if
        // it came from a second lookup.
        to: tok.address,
        data,
        ...ZERO_FEES,
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
      token: tok,
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
    /// THE RESOLVED TOKEN, not its symbol and not its decimals. Passing either
    /// alone is the shape that put a GOLD amount through PLAY's scale here: the
    /// event reported a second-currency spend as a near-zero number of an
    /// unnamed currency, and every assertion about the transfer still passed
    /// because the transfer was correct. The event was the only thing wrong.
    token: TokenModule;
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
      // wallet-mcp (ruled) so that money can never move without one:
      // wallet-mcp runs inside the persona, and a persona calling this endpoint
      // directly would otherwise produce a transfer with nobody deciding it.
      //
      // `via` preserves the tell that moving the emitter would have cost; see
      // spendVia for why it is a claim rather than a boundary.
      this.store.enqueueEvent('agent.spend', {
        kind: 'agent.spend',
        name: args.fromAgentId,
        to: args.to,
        // AT THE TOKEN'S OWN SCALE, AND NAMED. Both from the resolved token
        // this transfer was made in - formatting at the default token's
        // decimals reported 5 GOLD as 0.000000000005, and the reader had no
        // field telling it which currency it was looking at either.
        amount: formatVee(args.amount, args.token.decimals),
        token: args.token.symbol,
        // The old field beside the new one until v0.6.0, as everywhere else.
        vee: formatVee(args.amount, args.token.decimals),
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
  /// One token's movements for one wallet, newest first.
  ///
  /// ONE TOKEN, and with `token` omitted it is the DEFAULT token - which is the
  /// increment's one rule: a request that names no token behaves exactly as it
  /// did before there were two. Not every token merged: a merged history would
  /// interleave amounts in different scales under one `amount` field, and the
  /// reader would have to carry the unit per row to make sense of any of it.
  /// The row DOES carry its token, so a caller that wants two can ask twice and
  /// merge with the units intact.
  async history(name: string, limit: number, tokenArg?: unknown): Promise<HistoryEntry[]> {
    const who = await this.resolver.require(assertLookupName(name));
    // THE RESOLVED TokenModule, carried as ONE value from here on. Its address,
    // its symbol and its decimals are three facts about the same token, and
    // reading any of them from a second lookup is what lets one drift.
    const token = resolveToken(this.chain.modules, tokenArg);

    let logs;
    try {
      const [sent, received] = await Promise.all([
        (async () =>
          this.chain.publicClient.getContractEvents({
            address: token.address,
            abi: TokenAbi,
            eventName: 'Transfer',
            args: { from: who.address },
            fromBlock: 0n,
            toBlock: 'latest',
          }))(),
        (async () =>
          this.chain.publicClient.getContractEvents({
            address: token.address,
            abi: TokenAbi,
            eventName: 'Transfer',
            args: { to: who.address },
            fromBlock: 0n,
            toBlock: 'latest',
          }))(),
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
        // BOTH NAMES for one release: `amount` is the field from here on, and
        // `vee` stays beside it until v0.6.0 for the consumers on their own
        // bump cadence. A reader that takes `vee` when `amount` is absent would
        // pass the whole deprecation window while seeing one token.
        amount: formatVee(args.value, token.decimals),
        vee: formatVee(args.value, token.decimals),
        token: token.symbol,
        blockNumber: String(log.blockNumber ?? 0n),
        ...(memo ? { memo } : {}),
      });
    }
    return out;
  }

  // ── §3.2-§3.4. THE GENERIC CALL OP ─────────────────────────────────────
  //
  // Three operations, one shape: `call` signs with the caller's own key,
  // `admin-call` signs with the treasury's, and `read` signs nothing. They live
  // beside signTransfer rather than in a file of their own because they ARE
  // signTransfer, step for step, with the allowlist where the token used to be
  // hard-coded - and because the release rule, the reservation and the
  // principal derivation are the same three things that must not be rewritten.

  /// The ABI inputs a CALLER supplies, which is every input except the one the
  /// server fills with the intent id.
  ///
  /// Two index spaces exist from here on and confusing them is the bug this
  /// function is meant to make obvious: `calls.json` counts ABI indices - it is
  /// written against the contract - while the caller's `args` array has the
  /// intentArg slot missing. Every refusal quotes the CALLER's index, because
  /// that is the one they can act on.
  private static callerInputs(entry: CallEntry): {
    inputs: AbiParameter[];
    /// caller index -> ABI index.
    abiIndex: (i: number) => number;
    /// ABI index -> caller index, or null for the slot the server fills.
    callerIndex: (i: number) => number | null;
  } {
    const all = entry.abiFunction.inputs as readonly AbiParameter[];
    const skip = entry.intentArg;
    if (skip === undefined) {
      return { inputs: [...all], abiIndex: (i) => i, callerIndex: (i) => i };
    }
    return {
      inputs: all.filter((_, i) => i !== skip),
      abiIndex: (i) => (i < skip ? i : i + 1),
      callerIndex: (i) => (i === skip ? null : i < skip ? i : i - 1),
    };
  }

  /// §3.2 step 5. Turns the wire forms the validator accepted into addresses,
  /// applying the entry's per-index rule.
  ///
  /// THE VALIDATOR SAID THE SHAPE WAS ONE SOME RULE COULD TAKE; this says
  /// whether it is the one THIS index takes, and what it resolves to. Two
  /// layers because only the allowlist knows the rule and only the ABI knows
  /// the type - and the refusals share one detail format so a persona sees one
  /// shape of answer whichever layer produced it.
  private async resolveAddressArgs(
    entry: CallEntry,
    args: EncodableArg[],
    fromAgentId: string,
    policy: AgentPolicy,
  ): Promise<{ resolved: EncodableArg[]; named: Map<number, string> }> {
    const { inputs, abiIndex } = Treasury.callerInputs(entry);
    const resolved = [...args];
    /// What the caller CALLED each resolved address, for the event: the event
    /// reports the names and keys a persona used, never the addresses.
    const named = new Map<number, string>();

    for (let i = 0; i < inputs.length; i++) {
      if (inputs[i]!.type !== 'address') continue;
      const where = `argument ${i} (${inputs[i]!.name ?? ''})`;
      const rule = entry.addressArgs[abiIndex(i)];
      if (rule === undefined) {
        // WALLET SCOPE NEVER PASSES A RAW ADDRESS, and an address parameter
        // with no rule has no form it could take. Refused rather than defaulted
        // to `any`: a default would open every address parameter of every
        // future contract the moment it was added to the allowlist.
        throw new HttpError(
          'bad_args',
          `${where}: this function's address arguments are not callable by a wallet; ` +
            `no addressArgs rule for it`,
        );
      }
      const wire = args[i] as WireAddress;
      const key = Object.keys(wire)[0] as 'token' | 'contract' | 'name';
      const value = (wire as Record<string, string>)[key]!;

      if (rule === 'token' && key !== 'token') throw new HttpError('bad_args', `${where}: expected a token key`);
      if (rule === 'contract' && key !== 'contract') {
        throw new HttpError('bad_args', `${where}: expected a contract key`);
      }
      if (rule === 'name' && key !== 'name') throw new HttpError('bad_args', `${where}: expected a name`);

      if (key === 'token') {
        const token = this.chain.modules.tokens.find((t) => t.key === value);
        if (!token) throw new HttpError('bad_args', `${where}: expected a token key`);
        resolved[i] = token.address;
        named.set(i, value);
      } else if (key === 'contract') {
        // requireContract's own refusal is `unknown_contract`, which is the
        // right code when the CONTRACT is the subject of the request. Here the
        // contract key is an ARGUMENT, so the subject is the argument - and a
        // persona that gets `unknown_contract` for a call to a contract that
        // plainly exists would go looking in the wrong place.
        const found = this.chain.modules.byKey.get(value);
        if (!found) throw new HttpError('bad_args', `${where}: expected a contract key`);
        resolved[i] = found.address;
        named.set(i, value);
      } else {
        // A NAME, resolved exactly as sign-transfer resolves `to` - bare-id
        // rules included - and subject to the SAME deny list. A persona's deny
        // list is about whom it may pay, and paying through a contract call is
        // still paying: a deny that applied to `send` and not to `call` would
        // be a deny with a documented bypass.
        const target = await this.resolveTo(assertLookupName(value), fromAgentId);
        await this.assertNotDeniedByIdentity(policy, target.address, value);
        resolved[i] = target.address;
        named.set(i, target.canonical ?? value);
      }
    }
    return { resolved, named };
  }

  /// §3.2 step 6. WHICH TOKEN AND HOW MUCH, with no policy in it.
  ///
  /// This header described `perTxCap` as live and said "two bounds can hold at
  /// once" - both true of v0.4.0 and neither true since this increment retired
  /// the field. The comment survived the change because nothing compiles a
  /// comment: the code moved, its description stayed, and a reader would have
  /// gone looking for an entry-level bound that is now refused at load.
  ///
  /// ONE BOUND NOW, and it lives on the wallet: caps are per wallet per token,
  /// so the wallet carries a limit for every currency it may spend and the
  /// allowlist entry has nothing left to say about amounts.
  ///
  /// Split out of `callAmount` so the ADMIN path can reach the same answer:
  /// §3.3 gives the hub no cap, so it needs the resolution and the scaling and
  /// none of the enforcement. Sharing the function rather than restating the
  /// resolution is the point - the token, its decimals and its address are
  /// three facts about one thing, and a second implementation is where one of
  /// them drifts.
  private callMoney(
    entry: CallEntry,
    args: EncodableArg[],
    wireArgs: unknown[],
  ): { amount: bigint; token: TokenModule; index: number } | null {
    if (!entry.amount) return null;
    const { callerIndex } = Treasury.callerInputs(entry);

    const i = callerIndex(entry.amount.arg);
    if (i === null) {
      // The allowlist put the amount in the slot the server fills. Refused at
      // load, so this is unreachable - and it is an internal_error rather than
      // a bad_args, because the caller did nothing wrong.
      throw new HttpError('internal_error', `calls.json: amount.arg is the intentArg slot`);
    }

    const tokens = this.chain.modules.tokens;
    let token: TokenModule | undefined;
    if (typeof entry.amount.token === 'string') {
      token = tokens.find((t) => t.key === entry.amount!.token);
    } else {
      // The token whose ADDRESS is that argument - resolved by step 5 already,
      // so this reads an address rather than a wire form.
      const at = callerIndex(entry.amount.token.arg);
      const address = at === null ? undefined : (args[at] as string);
      token = tokens.find((t) => t.address.toLowerCase() === String(address).toLowerCase());
    }
    if (!token) {
      // Reachable: the caller named a contract key that IS in the registry and
      // is not a token, in a slot the entry calls the amount's token. A fact
      // about their own input.
      throw new HttpError(
        'bad_args',
        `argument ${callerIndex(
          typeof entry.amount.token === 'string' ? entry.amount.arg : entry.amount.token.arg,
        )}: expected a token this deployment carries`,
      );
    }

    // AN AMOUNT IS IN WHOLE UNITS ON THE WIRE AND IN THE TOKEN'S SMALLEST UNIT
    // IN THE CALLDATA, and this is where the two meet. The validator saw a
    // uint256 and produced `40n`, which is the right reading of an ordinary
    // uint argument and the WRONG one for money: `"40"` from a persona means 40
    // PLAY, and the contract takes 40e18. So the amount slot is re-parsed, with
    // the DECIMALS OF THE TOKEN THAT ACTUALLY RESOLVED - the scale differs per
    // token (PLAY 18, GOLD 6), and using the default token's would multiply a
    // gold amount by a trillion.
    //
    // Re-parsed from the WIRE value rather than scaled from the validator's
    // bigint, so there is exactly one conversion and no chance of a double one.
    const amount = parseVee(wireArgs[i], token.decimals, token.symbol, `argument ${i}`);
    if (amount <= 0n) throw new HttpError('invalid_amount', 'the amount must be greater than zero');
    return { amount, token, index: i };
  }

  private callAmount(
    entry: CallEntry,
    args: EncodableArg[],
    wireArgs: unknown[],
    policy: AgentPolicy,
  ): { amount: bigint; token: TokenModule; index: number } | null {
    const money = this.callMoney(entry, args, wireArgs);
    if (!money) return null;
    const { amount, token } = money;

    // EVERY TOKEN GOES THROUGH THE SAME CHECK NOW. This used to run only for
    // the DEFAULT token, because caps were denominated in it and any other
    // token had to be bounded by the allowlist entry's own `perTxCap`. Caps are
    // per wallet per token, so the wallet carries a bound for every currency it
    // may spend, and the entry has nothing left to say about it.
    //
    // The consequence is worth naming: a wallet with NO cap entry for this
    // token now cannot spend it through a call either, because `capsFor`
    // refuses inside `enforcePolicy` - the same fail-closed rule the transfer
    // path follows, reached by the same function.
    {
      // The wallet's own per-transaction cap, and the deny/allow lists - with
      // the CONTRACT KEY as the counterparty, so a policy can name contracts
      // the way it names wallets. enforcePolicy is pure string matching, so
      // this works mechanically; the consequence is a standing rule, written
      // in policy-defaults.json: a kind whose allow list is not ["*"] must name
      // every contract key its callers may pay through.
      try {
        enforcePolicy({
          policy,
          to: entry.contract,
          canonical: entry.contract,
          amount,
          decimals: token.decimals,
          symbol: token.symbol,
          // THE TOKEN THAT ACTUALLY RESOLVED, not the default: a call may move
          // any registered token, and the cap that bounds it is that token's.
          tokenKey: token.key,
        });
      } catch (err) {
        // THE ONE REFUSAL A SCENARIO AUTHOR WILL MEET AND MISREAD. The allow
        // list is matched against the CONTRACT KEY here, and a per-scenario
        // policy override REPLACES the kind defaults rather than extending them
        // (mergePolicy: `p.allow ?? defaults.allow`) - so a scenario that sets
        // `allow: ["acme:*"]` silently drops the `converter` entry that
        // policy-defaults.json carries, and every call whose amount is in the
        // default token is refused.
        //
        // The code stays `counterparty_denied`, because that is what it is. The
        // DETAIL says which list to edit, because "converter is not an allowed
        // counterparty" sends an author looking at wallets.
        if (err instanceof HttpError && err.code === 'counterparty_denied') {
          throw new HttpError(
            'counterparty_denied',
            `this wallet's policy does not allow paying through the contract "${entry.contract}". ` +
              `Allow lists name contracts as well as wallets: add "${entry.contract}" to this ` +
              `wallet's allow list, or to its kind's defaults.`,
          );
        }
        throw err;
      }
    }

    return money;
  }

  /// The allowlist entry for this request, or the one refusal that covers every
  /// way there is not one.
  ///
  /// ONE CODE FOR ALL OF THEM, deliberately: no entry, an entry of the wrong
  /// sort, and an entry this wallet's kind is not in are all
  /// `function_not_allowed`. Distinguishing them would tell a persona what
  /// OTHER kinds of wallet are permitted to do, which is the one thing the
  /// allowlist is keeping from it.
  private entryFor(
    snapshot: Allowlist,
    contractKey: string,
    fn: unknown,
    want: 'call' | 'read' | 'admin',
  ): CallEntry {
    if (typeof fn !== 'string' || fn === '') {
      throw new HttpError('invalid_request', 'function must be a string');
    }
    const entry = snapshot.find(contractKey, fn);
    const refuse = (): never => {
      throw new HttpError('function_not_allowed', `${fn} is not callable on ${contractKey}`);
    };
    if (!entry) refuse();
    if (want === 'read' && !entry!.read) refuse();
    if (want !== 'read' && entry!.read) refuse();
    if (want === 'admin' && !entry!.admin) refuse();
    return entry!;
  }

  /// sha256 of the canonical JSON of the validated wire arguments.
  ///
  /// OF THE WIRE FORM, not of the resolved addresses, and the two differ: the
  /// same `{"name":"alpha"}` resolves to a different address if alpha's wallet
  /// is respawned. The replay check asks "is this the same CALL", and the call
  /// is what the caller wrote. wallet-mcp hashes the same thing on its side, so
  /// its local `duplicate_intent` and this cannot disagree.
  private static argsHash(args: unknown[]): string {
    const canonical = JSON.stringify(args, (_k, v) =>
      typeof v === 'bigint' ? `${v}#bigint` : v,
    );
    return createHash('sha256').update(canonical).digest('hex');
  }

  /// The allowlist as it stands right now, for `GET /calls`.
  ///
  /// A READ-ONLY ACCESSOR rather than exposing the source, so the route cannot
  /// hold a snapshot across requests: the file is hub-set and may be rewritten
  /// between turns, and a menu that lagged it would advertise calls that are no
  /// longer permitted.
  allowlist(): Allowlist {
    return this.calls.snapshot();
  }

  /// §3.2. A wallet calls a contract with its own key.
  async call(
    principal: Principal,
    body: { fromAgentId?: unknown; contract?: unknown; function?: unknown; args?: unknown; intentId?: unknown },
    clientMarker?: string,
  ): Promise<{ txHash: string; intentId: string; intentIdSource: 'caller' | 'server' }> {
    // 1. WHO. Derived from the credential, never from the body; a body
    //    fromAgentId is tolerated only when it agrees.
    const fromAgentId = walletPrincipal(principal, body.fromAgentId);

    // 2. WHAT. One snapshot for the whole request, so a reload between two
    //    checks cannot apply one version to the kinds and another to the caps.
    const snapshot = this.calls.snapshot();
    if (typeof body.contract !== 'string') {
      throw new HttpError('invalid_request', 'contract must be a string');
    }
    const contract = requireContract(this.chain.modules, body.contract);
    const entry = this.entryFor(snapshot, contract.key, body.function, 'call');

    // 3. FROZEN. The store is the single truth; wallet-mcp's copy is a
    //    courtesy and loses any disagreement.
    if (this.store.isFrozen(fromAgentId)) {
      throw new HttpError('wallet_frozen', `${fromAgentId} is frozen`);
    }

    // 4. KIND. A pre-v4 wallet has a null kind and is read as `agent` HERE, at
    //    request time, for this decision only. That is not the backfill
    //    migrate.ts forbids: nothing is written, and `spawns.kind` still says
    //    "this wallet was spawned before chain-svc recorded kinds", which stays
    //    the true answer to a different question.
    const kind = this.store.walletRow(fromAgentId)?.kind ?? 'agent';
    if (!entry.kinds.includes(kind)) {
      throw new HttpError('function_not_allowed', `${entry.function} is not callable on ${contract.key}`);
    }

    // 5. ARGUMENTS. Shape first, against the ABI; then the entry's per-index
    //    address rules, which resolve names through the registry and apply this
    //    wallet's deny list.
    const supplied = Array.isArray(body.args) ? body.args : null;
    if (supplied === null) throw new HttpError('bad_args', 'args must be an array');
    const { inputs } = Treasury.callerInputs(entry);
    const shaped = validateArgs(inputs, supplied, 'wallet');
    const policy = await this.policyFor(fromAgentId);
    const { resolved, named } = await this.resolveAddressArgs(entry, shaped, fromAgentId, policy);

    // 6. MONEY. Null when the entry declares no amount - which is the
    //    push-only rule holding: a function that PULLED funds would need an
    //    allowance, and this service has none to give.
    const money = this.callAmount(entry, resolved, supplied, policy);
    // The scaled amount is what the contract is called with. Written back here
    // rather than inside callAmount so that "which argument the calldata
    // carries" is visible at the call site rather than as a side effect.
    if (money) resolved[money.index] = money.amount;

    // 7-8. THE RESERVATION, covering the intent, the stage hold and the
    //    per-entry count in one transaction, before anything is signed.
    const stage = await this.currentStage();
    const suppliedId = typeof body.intentId === 'string' && body.intentId !== '';
    const idSource = suppliedId ? ('caller' as const) : ('server' as const);
    const intentId = suppliedId ? (body.intentId as string) : `chain-svc:${randomUUID()}`;
    const argsHash = Treasury.argsHash(supplied);

    const reservation = this.store.reserve({
      intentId,
      topic: intentTopic(intentId),
      reservedAtBlock: this.store.observedHead() ?? undefined,
      idSource,
      agentId: fromAgentId,
      stage,
      amount: money?.amount ?? 0n,
      // THE TOKEN THAT ACTUALLY RESOLVED. A call moving no money still needs a
      // coordinate for its intents row, and the default is the honest one
      // there: nothing was held in any currency.
      token: money?.token.key ?? defaultToken(this.chain.modules).key,
      // A HOLD FOR WHICHEVER TOKEN MOVED. `stage_spend` is keyed by token, and
      // the wallet carries a per-stage bound for each - so a call moving gold
      // takes a gold hold against a gold cap, and leaves the play budget alone.
      // Before per-token caps this could only be taken for the default token,
      // which meant every other currency had an unbounded stage.
      capWei: money ? stageCapWei(policy, money.token.key, money.token.decimals) : null,
      call: {
        contract: contract.key,
        function: entry.function,
        argsHash,
        maxPerStage: entry.maxPerStage,
      },
    });

    if (reservation.outcome === 'over_stage_cap') {
      throw new HttpError(
        'over_stage_cap',
        entry.maxPerStage !== undefined && !money
          ? `${entry.function} may be called ${entry.maxPerStage} times per stage`
          : `max_per_stage is ${capsFor(policy, money!.token.key).max_per_stage} for this stage`,
      );
    }
    if (reservation.outcome === 'duplicate') {
      // A REPLAY IS ONLY A REPLAY IF IT IS THE SAME CALL. chain-svc answers a
      // repeated intent id with the original transaction hash, which is right
      // for a retry and wrong for a DIFFERENT call wearing a used id - that
      // caller would be told their second call had succeeded.
      const first = this.store.intentCall(intentId);
      if (first && (first.contract !== contract.key || first.function !== entry.function || first.argsHash !== argsHash)) {
        throw new HttpError(
          'invalid_request',
          `intent_id reused with a different call: ${intentId} was reserved for ` +
            `${first.function} on ${first.contract}`,
        );
      }
      if (reservation.txHash) {
        return { txHash: reservation.txHash, intentId, intentIdSource: idSource };
      }
      throw new HttpError(
        'intent_unresolved',
        `intent ${intentId} is reserved with no recorded transaction: an earlier attempt reached ` +
          `the broadcast and its outcome is unknown. Reconcile against the chain using THIS intent ` +
          `id - never retry with a fresh one, which would call a second time.`,
      );
    }

    // 9. SIGN AND SEND.
    const finalArgs = Treasury.withIntentArg(entry, resolved, intentId);

    // --- PROVABLY BEFORE THE BROADCAST ------------------------------------
    // Loading the key, building the client and preparing the request are local
    // or read-only; none of them can put a transaction on the wire. A failure
    // here therefore provably precedes the broadcast, and this is the ONLY
    // thing in this method that may release.
    let serializedTransaction: `0x${string}`;
    let wallet: Signer;
    try {
      const { privateKey } = await this.keystore.load(fromAgentId);
      const account = privateKeyToAccount(privateKey);
      wallet = this.signerFor(account);
      const data = encodeFunctionData({
        abi: contract.abi,
        functionName: entry.function,
        args: finalArgs as never,
      });
      const request = await wallet.prepareTransactionRequest({
        account,
        chain: this.chain.viemChain,
        to: contract.address,
        data,
        ...ZERO_FEES,
      });
      serializedTransaction = await wallet.signTransaction(request as never);
    } catch (err) {
      this.store.release(intentId);
      // asCallError, NOT asChainError, and this is THE PERSONA-FACING OP.
      //
      // `prepareTransactionRequest` ESTIMATES GAS when the request carries none
      // - and ZERO_FEES sets fees, not gas - so a call the contract would
      // reject fails HERE, at the estimate, and never reaches a receipt. Under
      // asChainError that came out as 502 chain_error WITH viem's text in the
      // detail, because errorBody ships a detail for every code: the primary
      // path both mis-classified a revert as a dead node AND handed the persona
      // the revert reason §3.2 step 9 exists to withhold. Measured against a
      // node answering "execution reverted: pair is paused".
      //
      // The release is unaffected and stays above: an estimate is a READ, so a
      // failure here still provably precedes the broadcast.
      throw this.asCallError(err, `${entry.function} on ${contract.key} for ${fromAgentId}`);
    }

    // --- AT OR AFTER THE BROADCAST ----------------------------------------
    // From here the reservation STANDS whatever happens - including a mined
    // revert, which keeps its stage slot because it was mined.
    const txHash = await this.broadcastCall({
      wallet,
      serializedTransaction,
      intentId,
      contract,
      entry,
      wireArgs: supplied,
      named,
      money,
      actor: { kind: 'agent.call', name: fromAgentId, agentKind: kind },
      via: spendVia(clientMarker),
    });
    return { txHash, intentId, intentIdSource: idSource };
  }

  /// The intent id goes into the slot the entry named, and the caller may not
  /// supply it: a value there is a caller trying to choose the id the chain
  /// will log, which is the join the anomaly detector reads.
  private static withIntentArg(
    entry: CallEntry,
    args: EncodableArg[],
    intentId: string,
  ): EncodableArg[] {
    if (entry.intentArg === undefined) return args;
    const out = [...args];
    out.splice(entry.intentArg, 0, intentTopic(intentId));
    return out;
  }

  /// The post-broadcast tail for a call, extracted for the same reason
  /// `broadcast` is: the release rule above needs exactly one catch to live in,
  /// and this one must not quietly grow a second.
  private async broadcastCall(args: {
    wallet: Pick<Signer, 'sendRawTransaction'>;
    serializedTransaction: `0x${string}`;
    intentId: string;
    contract: RegisteredContract;
    entry: CallEntry;
    wireArgs: unknown[];
    named: Map<number, string>;
    money: { amount: bigint; token: TokenModule } | null;
    actor: { kind: 'agent.call'; name: string; agentKind: string };
    via: string;
  }): Promise<string> {
    const hash = await args.wallet.sendRawTransaction({
      serializedTransaction: args.serializedTransaction,
    });
    // Recorded as soon as there IS a hash, before the receipt: a crash while
    // waiting must still leave the retry able to find the original call.
    this.store.completeIntent(args.intentId, hash);
    const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
    const reverted = receipt.status === 'reverted';

    // THE EVENT IS EMITTED FOR BOTH OUTCOMES. A reverted call is a thing the
    // persona did - it reached the chain, it cost a stage slot - and a feed
    // that showed only the successes would show a persona trying nothing when
    // it was trying repeatedly.
    this.store.enqueueEvent(args.actor.kind, {
      kind: args.actor.kind,
      name: args.actor.name,
      contract: args.contract.key,
      function: args.entry.function,
      // THE NAMES AND KEYS THE CALLER USED, never the addresses they resolved
      // to. The feed is read by the operator and mirrors what the persona
      // believes it did.
      args: args.wireArgs,
      intent_id: args.intentId,
      via: args.via,
      txHash: hash,
      status: reverted ? 'reverted' : 'ok',
      ...(args.money
        ? {
            amount: {
              value: formatVee(args.money.amount, args.money.token.decimals),
              token: args.money.token.key,
            },
          }
        : {}),
    });

    if (reverted) {
      // THE CODE CROSSES TO THE PERSONA AND THE REASON DOES NOT. It must know
      // its call did nothing, or it will act as though it worked; the revert
      // string is the contract's internal state talking, and a game's
      // machinery is not a player's to read.
      //
      // The reservation STANDS - the call was mined, so the release rule keeps
      // it, and the stage slot it consumed stays consumed.
      console.warn(
        `[chain-svc] ${args.entry.function} on ${args.contract.key} reverted for ` +
          `${args.actor.name} (intent ${args.intentId}, tx ${hash})`,
      );
      throw new HttpError('revert', 'the call was mined and reverted; nothing changed');
    }
    return hash;
  }

  /// A failure from a contract call, classified.
  ///
  /// A REVERT IS NOT A CHAIN ERROR, and `asChainError` cannot tell them apart:
  /// it saw "The contract function \"setPair\" reverted." and answered
  /// `chain_error`, a 502 that says the NODE is broken about a chain doing
  /// exactly what it was asked. Measured against a real Anvil - `writeContract`
  /// simulates before it sends, so a contract-level refusal arrives here as an
  /// exception rather than as a reverted receipt, which is the one way this
  /// path differs from `call`.
  ///
  /// THE REASON GOES TO THE LOG SINK, NEVER TO THE CALLER, exactly as §3.2.9
  /// requires of the mined case. viem's message carries the function name and
  /// the decoded custom error, which is the contract's internal state talking.
  private asCallError(err: unknown, where: string): HttpError {
    if (err instanceof HttpError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (/revert/i.test(message)) {
      console.warn(`[chain-svc] ${where} reverted: ${message.split('\n')[0]}`);
      return new HttpError('revert', 'the call was mined and reverted; nothing changed');
    }
    return asChainError(err);
  }

  /// §3.3. The hub calls a contract with the treasury's key.
  ///
  /// NO KIND, FROZEN, CAP, COUNT OR ADDRESS RULE: platform scope is the
  /// operator, and per-stage counting is a persona budget rather than an
  /// operator one. What DOES apply is the entry: `admin: true` must be written
  /// in calls.json, so the hub's powers are on the record beside the personas'.
  async adminCall(body: {
    contract?: unknown;
    function?: unknown;
    args?: unknown;
    intentId?: unknown;
  }): Promise<{ txHash: string; intentId: string }> {
    const snapshot = this.calls.snapshot();
    if (typeof body.contract !== 'string') {
      throw new HttpError('invalid_request', 'contract must be a string');
    }
    const contract = requireContract(this.chain.modules, body.contract);
    const entry = this.entryFor(snapshot, contract.key, body.function, 'admin');

    const supplied = Array.isArray(body.args) ? body.args : null;
    if (supplied === null) throw new HttpError('bad_args', 'args must be an array');
    const { inputs } = Treasury.callerInputs(entry);
    const shaped = validateArgs(inputs, supplied, 'platform');

    // §4. THE SAME `amount` THE AGENT EVENT CARRIES, so the feed reader sees one
    // shape for both. Informational only here: §3.3 gives the hub no cap, so
    // this is the operator moving money and nothing bounds it - which is the
    // reason it is worth recording at all.
    //
    // Through `callMoney`, the same function the agent path uses, so the token
    // resolution and the whole-units-to-smallest-units scaling happen once in
    // the codebase. `calls.json` accepts an `amount` on an admin entry, so this
    // is reachable rather than defensive.
    const money = this.callMoney(entry, shaped, supplied);
    // The scaled amount is what the contract is called with - the same
    // write-back the agent path does at its call site, and for the same reason:
    // the validator read the wire's "40" as 40n, which is right for an ordinary
    // uint and a 1e18x error for money.
    if (money) shaped[money.index] = money.amount;
    const moneyField = money
      ? {
          amount: {
            value: formatVee(money.amount, money.token.decimals),
            token: money.token.key,
          },
        }
      : {};

    const stage = await this.currentStage();
    // ONE TEST FOR BOTH, and it is the test `call` uses: a string AND
    // non-empty. Asking only `typeof body.intentId === 'string'` recorded an
    // empty-string id as CALLER-supplied while generating a server one - so the
    // column said the caller chose an id it never sent, which is exactly the
    // fact the anomaly detector reads to tell a guessable id from a generated
    // one.
    const suppliedId = typeof body.intentId === 'string' && body.intentId !== '';
    const intentId = suppliedId ? (body.intentId as string) : `chain-svc:${randomUUID()}`;
    const argsHash = Treasury.argsHash(supplied);

    // THE SAME RESERVATION, for the idempotency half only: `capWei: null`
    // because the treasury has no stage cap, and a fixed pseudo-id because
    // `intents.agent_id` records WHO reserved it and the hub is not a wallet.
    const reservation = this.store.reserve({
      intentId,
      topic: intentTopic(intentId),
      idSource: suppliedId ? 'caller' : 'server',
      agentId: 'platform',
      stage,
      amount: 0n,
      capWei: null,
      // No money moves through admin-call's reservation - it is the
      // idempotency half only - so this is a coordinate, not a claim that
      // anything was held in that currency.
      token: defaultToken(this.chain.modules).key,
      call: { contract: contract.key, function: entry.function, argsHash },
    });
    if (reservation.outcome === 'duplicate') {
      const first = this.store.intentCall(intentId);
      if (first && (first.contract !== contract.key || first.function !== entry.function || first.argsHash !== argsHash)) {
        throw new HttpError(
          'invalid_request',
          `intent_id reused with a different call: ${intentId} was reserved for ` +
            `${first.function} on ${first.contract}`,
        );
      }
      if (reservation.txHash) return { txHash: reservation.txHash, intentId };
      throw new HttpError(
        'intent_unresolved',
        `intent ${intentId} is reserved with no recorded transaction; reconcile against the chain ` +
          `using THIS intent id`,
      );
    }

    const finalArgs = Treasury.withIntentArg(entry, shaped, intentId);
    let hash: `0x${string}`;
    try {
      hash = await this.chain.walletClient.writeContract({
        account: this.chain.walletClient.account!,
        chain: this.chain.viemChain,
        address: contract.address,
        abi: contract.abi,
        functionName: entry.function,
        args: finalArgs as never,
        ...ZERO_FEES,
      });
    } catch (err) {
      // --- AT OR AFTER THE BROADCAST --------------------------------------
      // NO RELEASE HERE, and it is not an omission. `writeContract` simulates
      // AND sends, and a caller cannot tell from the outside which half threw:
      // a simulation refusal provably precedes the broadcast, a send error does
      // not, and "the call landed and the response was lost" is precisely the
      // case an idempotency key exists for. The release rule takes the
      // conservative branch for both.
      //
      // What that costs is small and worth naming: a simulation-time revert
      // consumes the intent id, so a retry needs a fresh one. The hub generates
      // one per request unless it supplies its own, so in practice this is the
      // operator repeating a command rather than reconciling anything.
      const classified = this.asCallError(err, `admin-call ${entry.function} on ${contract.key}`);
      // THE OPERATOR'S REFUSED ACTION REACHES THE FEED TOO (ruled).
      // `status: "refused"` is a third value beside ok and reverted, and it is
      // not decoration: nothing was mined, so a null hash under "reverted"
      // would lie about what happened, while silence would hide the hub trying
      // something the chain would not accept - which is exactly what a
      // operator wants to see.
      if (classified.code === 'revert') {
        this.store.enqueueEvent('hub.call', {
          kind: 'hub.call',
          contract: contract.key,
          function: entry.function,
          args: supplied,
          intent_id: intentId,
          txHash: null,
          status: 'refused',
          ...moneyField,
        });
      }
      throw classified;
    }
    this.store.completeIntent(intentId, hash);
    const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
    const reverted = receipt.status === 'reverted';

    this.store.enqueueEvent('hub.call', {
      kind: 'hub.call',
      contract: contract.key,
      function: entry.function,
      args: supplied,
      intent_id: intentId,
      txHash: hash,
      status: reverted ? 'reverted' : 'ok',
      ...moneyField,
    });
    if (reverted) {
      console.warn(
        `[chain-svc] admin-call ${entry.function} on ${contract.key} reverted ` +
          `(intent ${intentId}, tx ${hash})`,
      );
      throw new HttpError('revert', 'the call was mined and reverted; nothing changed');
    }
    return { txHash: hash, intentId };
  }

  /// §3.4. A view function, for anyone with a credential.
  ///
  /// NO SCOPE CHECK BEYOND THE ALLOWLIST: a view on a registered contract is
  /// public information on a private chain, and a persona could read the same
  /// from an explorer if the game had one. It signs nothing, reserves nothing
  /// and costs nothing, which is exactly why `read` first is the right advice
  /// for a persona unsure whether a call would revert.
  async read(
    principal: Principal,
    body: { contract?: unknown; function?: unknown; args?: unknown },
  ): Promise<{ result: unknown }> {
    const snapshot = this.calls.snapshot();
    if (typeof body.contract !== 'string') {
      throw new HttpError('invalid_request', 'contract must be a string');
    }
    const contract = requireContract(this.chain.modules, body.contract);
    const entry = this.entryFor(snapshot, contract.key, body.function, 'read');

    const platform = principal.scope === 'platform';
    if (!platform) {
      const agentId = walletPrincipal(principal, undefined);
      const kind = this.store.walletRow(agentId)?.kind ?? 'agent';
      if (!entry.kinds.includes(kind)) {
        throw new HttpError('function_not_allowed', `${entry.function} is not readable on ${contract.key}`);
      }
    }

    const supplied = Array.isArray(body.args) ? body.args : null;
    if (supplied === null) throw new HttpError('bad_args', 'args must be an array');
    const { inputs } = Treasury.callerInputs(entry);
    const shaped = validateArgs(inputs, supplied, platform ? 'platform' : 'wallet');
    const args = platform
      ? shaped
      : (await this.resolveAddressArgs(entry, shaped, walletPrincipal(principal, undefined), await this.policyFor(walletPrincipal(principal, undefined)))).resolved;

    let raw: unknown;
    try {
      raw = await this.chain.publicClient.readContract({
        address: contract.address,
        abi: contract.abi,
        functionName: entry.function,
        args: args as never,
      });
    } catch (err) {
      throw this.asCallError(err, `read ${entry.function} on ${contract.key}`);
    }

    const result = serialiseResult(raw, entry.abiFunction);
    // BYTES, not UTF-16 units, for the reason callargs.ts counts its string cap
    // in bytes: the bound exists to bound what crosses the wire, and a
    // character count admits up to four times as much of it.
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size > MAX_READ_BYTES) {
      // REFUSED, NOT TRUNCATED. A view returning an unbounded array is a
      // contract design problem, and a truncated answer hides it behind a
      // result that looks complete.
      throw new HttpError('bad_args', 'result too large; call a narrower view');
    }
    return { result };
  }
}
