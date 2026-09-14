// The chain event tail (spec S4): every movement of money becomes a game event
// without any agent having to report it honestly.
//
// Two halves, deliberately separate:
//   POLL     - read Transfer and Registered logs since the stored cursor and
//              put them in the outbox. Durable, so a restart resumes instead of
//              replaying from genesis.
//   DELIVER  - drain the outbox to hub-core. hub-core does not exist until C5,
//              so this must tolerate an absent or unreachable sink FOREVER:
//              events buffer and retry with backoff, are never dropped
//              silently, and can never take chain-svc down.

import { NameRegistryAbi, TokenAbi } from './abi.ts';
import type { Chain } from './chain.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { formatVee } from './validate.ts';

const CURSOR = 'chain-log-tail';
const DELIVER_BATCH = 50;

/// A hung sink must not become an unbounded socket queue. The interval fires
/// regardless of whether the last pass finished, so without BOTH a timeout and
/// a re-entrancy flag a stalled hub-core accumulates one in-flight POST per
/// tick - in the process that holds every wallet key. Backoff cannot help: it
/// lives in the catch, and a hang is not a rejection.
const SINK_TIMEOUT_MS = 5_000;

export class EventTail {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deliverTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private droppedTotal = 0;
  /// Re-entrancy guards. `setInterval` does not wait for the previous pass.
  private polling = false;
  private delivering = false;

  constructor(
    private readonly config: Config,
    private readonly chain: Chain,
    private readonly store: Store,
  ) {}

  /// Reads new logs into the outbox. Returns how many events were enqueued.
  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      return await this.poll();
    } finally {
      this.polling = false;
    }
  }

  private async poll(): Promise<number> {
    const latest = await this.chain.publicClient.getBlockNumber();
    // NO CURRENT CONSUMER, and this is where a reader meets the mechanism
    // first, so: this per-second write feeds `reserved_at_block`, which nothing
    // reads - not even the sweep below. It is recorded whether or not this pass
    // finds anything because the reserve-time head cannot be recovered
    // afterwards. See the `reservedAtBlock` comment on Store.reserve.
    this.store.setObservedHead(latest);
    const from = (this.store.getCursor(CURSOR) ?? -1n) + 1n;
    if (from > latest) return 0;

    const [transfers, registrations, intents] = await Promise.all([
      this.chain.publicClient.getContractEvents({
        address: this.chain.deployment.VEEBux,
        abi: TokenAbi,
        eventName: 'Transfer',
        fromBlock: from,
        toBlock: latest,
      }),
      this.chain.publicClient.getContractEvents({
        address: this.chain.deployment.NameRegistry,
        abi: NameRegistryAbi,
        eventName: 'Registered',
        fromBlock: from,
        toBlock: latest,
      }),
      this.chain.publicClient.getContractEvents({
        address: this.chain.deployment.VEEBux,
        abi: TokenAbi,
        eventName: 'IntentTransfer',
        fromBlock: from,
        toBlock: latest,
      }),
    ]);

    let enqueued = 0;
    for (const log of transfers) {
      const args = log.args as { from?: string; to?: string; value?: bigint };
      if (!args.from || !args.to || args.value === undefined) continue;
      this.enqueue('chain.transfer', {
        kind: 'chain.transfer',
        from: args.from,
        to: args.to,
        vee: formatVee(args.value),
        txHash: log.transactionHash,
      });
      enqueued++;
    }
    // TWO OR MORE IntentTransfers for ONE intent id is an INVARIANT VIOLATION,
    // not a race to be retried. chain-svc broadcasts at most once per
    // reservation - one reservation, one signature, one nonce - and a
    // re-broadcast of that same signed transaction can be included only once.
    // So a second emission means something bypassed the reservation.
    //
    // COUNTED IN THE STORE, NOT GROUPED IN THIS FUNCTION. Grouping here saw
    // only ONE POLL'S WINDOW, so two emissions seconds apart - the realistic
    // shape, since two chain-svc instances do not coordinate their timing -
    // were each a group of one and nothing was raised. Every test built both
    // emissions inside a single pollOnce against a stub whose head never moved,
    // so the boundary was not a variable in any of them.
    //
    // Never reconciled silently (ruled): the money moved, so the intent
    // is confirmed and the hold KEPT, and a facilitator is told.
    for (const log of intents) {
      const args = log.args as { intentId?: string; from?: string };
      if (!args.intentId || !log.transactionHash) continue;

      const anomaly = this.store.recordEmission({
        topic: args.intentId,
        txHash: log.transactionHash,
        from: args.from ?? null,
      });
      if (!anomaly) continue;

      const senders = anomaly.transfers.map((t) => t.from ?? 'unknown').join(', ');
      this.enqueue('chain.anomaly', {
        kind: 'chain.anomaly',
        intentId: args.intentId,
        agentId: anomaly.agentId,
        reason: anomaly.reason,
        // Whether the intent id was the CALLER'S or ours. The spec's question
        // for a foreign sender is intent-id PREDICTABILITY, and a facilitator
        // should not need a second lookup to answer it: a model-chosen id being
        // quoted by a stranger is a guessable id being guessed, and a
        // chain-svc:<uuid> being quoted is a different story entirely.
        idSource: anomaly.idSource,
        transfers: anomaly.transfers,
        detail:
          anomaly.reason === 'foreign_sender'
            ? `An IntentTransfer for this wallet's intent id was sent by ${senders}, which is ` +
              `not the wallet that reserved it. transferWithIntent is permissionless, so this is ` +
              `somebody spending THEIR OWN funds while quoting our intent id - it says nothing ` +
              `about this wallet's key, and the reservation is NOT resolved by it. Inspect that ` +
              `sender. The id was ${anomaly.idSource ?? 'of unrecorded origin'}` +
              (anomaly.idSource === 'caller'
                ? ', so it was chosen by the caller and may be guessable - that is the question to ask.'
                : ', so it was generated here and is not guessable, which makes how they learned it the question.')
            : `${anomaly.emissions} IntentTransfer events for one intent id. chain-svc broadcasts ` +
              `at most once per reservation, so this means the reservation was bypassed - most ` +
              `likely a second chain-svc with a separate store writing to this chain, or an ` +
              `out-of-band transfer reusing the id. The money moved; freeze the named wallet and ` +
              `inspect the other sender. Senders: ${senders}.`,
      });
      enqueued++;
    }

    for (const log of registrations) {
      const args = log.args as { name?: string; owner?: string; target?: string };
      if (!args.name) continue;
      this.enqueue('chain.name', {
        kind: 'chain.name',
        name: args.name,
        owner: args.owner,
        target: args.target,
        txHash: log.transactionHash,
      });
      enqueued++;
    }

    // The cursor advances only after the events are in the outbox, so a crash
    // mid-poll re-reads the range rather than skipping it. That can duplicate
    // an event; losing one is worse, because the outcome feed is the record
    // nobody can lie to.
    this.store.setCursor(CURSOR, latest);
    return enqueued;
  }

  private enqueue(kind: string, payload: unknown): void {
    const dropped = this.store.enqueueEvent(kind, payload);
    if (dropped > 0) {
      this.droppedTotal += dropped;
      console.warn(
        `chain-svc: event buffer full, dropped ${dropped} oldest event(s) ` +
          `(${this.droppedTotal} total). hub-core has not accepted events for some time.`,
      );
    }
  }

  /// Resolves reservations the chain has already answered (spec S4).
  ///
  /// RESOLVE AND DETECT, NEVER RELEASE (ruled). There is one branch and
  /// it only ever moves an intent from unresolved to CONFIRMED:
  ///
  ///   an IntentTransfer for this intent FROM THE RESERVING WALLET means it
  ///   landed, so the intent is completed with that hash and the hold is KEPT,
  ///   because the money moved. The sender constraint is not optional -
  ///   `transferWithIntent` is permissionless, so an emission under our id
  ///   proves an event EXISTS, not that chain-svc made it.
  ///
  /// THERE IS DELIBERATELY NO NEGATIVE BRANCH, and the reason is worth more
  /// than the code it replaces. A first version failed intents when the cursor
  /// had passed the block recorded at reservation. That block is a LOWER bound
  /// - a transfer cannot be BELOW it - and the branch needed an UPPER one.
  /// Knowing the cursor is past the same floor says nothing about whether it is
  /// past the transaction. Worse, `cursor == bound` is the ORDINARY post-poll
  /// state, because a poll sets the observed head and the cursor to the same
  /// number, so a reservation taken just after a poll was failed by the very
  /// next sweep - refunding a hold for money that had moved and, because the
  /// fail path deleted the row, FREEING THE IDEMPOTENCY KEY. The retry then
  /// broadcast a second transfer: the double-charge, through the component
  /// added to prevent it.
  ///
  /// "Provably did not land" is not something scanning can establish at all: a
  /// signed transaction can sit in the mempool arbitrarily long, so absence is
  /// never proof of never. `held` is the terminal pessimistic state for a
  /// post-broadcast unknown, and it is not permanent - stage spend is keyed by
  /// (agent, stage), so a stuck hold clears at stage rollover. Pre-broadcast
  /// failures already release at send time, where the failure IS provable.
  ///
  /// WHAT A REAL NEGATIVE BRANCH WOULD NEED, recorded so the next person does
  /// not re-derive the lower-bound reasoning: the TRANSACTION NONCE on the row,
  /// plus proof that a DIFFERENT transaction consumed it - a nonce consumed by
  /// something else makes ours unlandable, which is the only true proof
  /// available. A nonce alone is NOT enough: an advanced nonce cannot separate
  /// "another transaction took ours" from "OURS landed and the emission is not
  /// indexed yet". Distinguishing them needs the head observed at the moment
  /// the nonce was seen to have advanced, and then waiting for the cursor to
  /// pass THAT. Two phases, two columns, and a money-surface PR of its own.
  async sweepOnce(): Promise<{ confirmed: number; held: number }> {
    let confirmed = 0;
    let held = 0;

    for (const intent of this.store.unresolvedIntents()) {
      const wallet = this.store.spawnedAddress(intent.agentId);
      const landed =
        intent.emissions > 0 &&
        intent.firstTx !== null &&
        wallet !== null &&
        intent.firstFrom !== null &&
        intent.firstFrom.toLowerCase() === wallet.toLowerCase();

      if (landed) {
        this.store.completeIntent(intent.intentId, intent.firstTx!);
        confirmed++;
        continue;
      }
      held++;
    }

    return { confirmed, held };
  }

  /// Drains the outbox. Returns what happened, so a test can assert delivery
  /// rather than infer it from the absence of an error.
  async deliverOnce(): Promise<{ delivered: number; failed: number; skipped: boolean }> {
    if (!this.config.hubCoreUrl) return { delivered: 0, failed: 0, skipped: true };
    // Skipped, not queued: a pass that is still running will drain the outbox,
    // and stacking passes is the exhaustion this guard exists to stop.
    if (this.delivering) return { delivered: 0, failed: 0, skipped: true };
    this.delivering = true;
    try {
      return await this.deliver();
    } finally {
      this.delivering = false;
    }
  }

  private async deliver(): Promise<{ delivered: number; failed: number; skipped: boolean }> {

    const due = this.store.dueEvents(DELIVER_BATCH);
    let delivered = 0;
    let failed = 0;

    for (const event of due) {
      try {
        const res = await fetch(new URL('/events', this.config.hubCoreUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.token}` },
          body: event.payload,
          // A hang is not a rejection, so the catch below cannot see one
          // without this: the timeout is what turns "stalled for ever" into a
          // failure the backoff can act on.
          signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`hub-core replied ${res.status}`);
        this.store.eventDelivered(event.id);
        delivered++;
      } catch {
        // Backoff, keep the event. A sink that is down must not cost us the
        // record of what happened while it was down.
        this.store.eventFailed(event.id);
        failed++;
      }
    }
    return { delivered, failed, skipped: false };
  }

  /// The sweep runs FAR less often than the poll, and the difference is not a
  /// performance guess: the poll must keep up with the chain, while the sweep
  /// only resolves reservations the poll has ALREADY recorded. Running it at
  /// the poll's cadence would re-walk the same unresolved rows every second to
  /// learn nothing new, because nothing can change between polls that the poll
  /// did not itself record.
  start(pollMs = 1000, deliverMs = 1000, sweepMs = 30_000): void {
    // Failures are swallowed on purpose: the tail is a background reporter and
    // must never be able to stop the service that holds the wallets. That now
    // covers the sweep too, and it matters more there - the sweep touches the
    // intents table, and an exception escaping a timer would take the process
    // down with every wallet key in it.
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => console.warn('chain-svc: event poll failed', (err as Error).message));
    }, pollMs);
    this.deliverTimer = setInterval(() => {
      void this.deliverOnce().catch((err) => console.warn('chain-svc: event delivery failed', (err as Error).message));
    }, deliverMs);
    this.sweepTimer = setInterval(() => {
      void this.sweepOnce().catch((err) => console.warn('chain-svc: intent sweep failed', (err as Error).message));
    }, sweepMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.deliverTimer) clearInterval(this.deliverTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.pollTimer = null;
    this.deliverTimer = null;
    this.sweepTimer = null;
  }
}
