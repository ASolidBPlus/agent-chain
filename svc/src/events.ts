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

import { NameRegistryAbi, VEEBuxAbi } from './abi.ts';
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
    const from = (this.store.getCursor(CURSOR) ?? -1n) + 1n;
    if (from > latest) return 0;

    const [transfers, registrations, intents] = await Promise.all([
      this.chain.publicClient.getContractEvents({
        address: this.chain.deployment.VEEBux,
        abi: VEEBuxAbi,
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
        abi: VEEBuxAbi,
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
    // So a second event means something bypassed the reservation: in practice a
    // second chain-svc with its own store writing to this chain, since
    // reservation uniqueness is scoped to one database and not to the chain, or
    // an out-of-band transfer reusing an id.
    //
    // Never reconciled silently (ruled 03:12): the intent is marked CONFIRMED
    // because the money did move, the hold is KEPT, and a facilitator is told.
    // Grouped WITH THE SENDER, not just the hash. `IntentTransfer` indexes
    // `from` and it is in hand here; dropping it left the payload unable to
    // answer the question its own detail string tells the operator to ask.
    //
    // It matters more than a missing field: `transferWithIntent` is
    // PERMISSIONLESS, so anyone with chain access can emit an IntentTransfer
    // under any id - and a party like that existing is the PREMISE of this
    // alert. The sender is what separates "a second chain-svc with its own
    // store" from "an id collision" from "somebody spamming the event". Without
    // it the alert names a wallet to freeze and cannot say who moved against it.
    const byIntent = new Map<string, Array<{ txHash: string; from: string | null }>>();
    for (const log of intents) {
      const args = log.args as { intentId?: string; from?: string };
      // A missing `from` does NOT drop the log: the COUNT is the anomaly
      // signal, so discarding a malformed emission could hide the second
      // transfer that makes this an anomaly at all - failing open on exactly
      // the case the alert exists for. It is recorded with a null sender
      // instead, which is honest about what is known and still counts.
      if (!args.intentId || !log.transactionHash) continue;
      byIntent.set(args.intentId, [
        ...(byIntent.get(args.intentId) ?? []),
        { txHash: log.transactionHash, from: args.from ?? null },
      ]);
    }
    for (const [intentTopic, emissions] of byIntent) {
      if (emissions.length < 2) continue;
      this.enqueue('chain.anomaly', {
        kind: 'chain.anomaly',
        intentId: intentTopic,
        agentId: this.store.agentForIntentTopic(intentTopic),
        transfers: emissions,
        detail:
          `${emissions.length} IntentTransfer events for one intent id. chain-svc broadcasts at ` +
          `most once per reservation, so this means the reservation was bypassed - most likely a ` +
          `second chain-svc with a separate store writing to this chain, or an out-of-band ` +
          `transfer reusing the id. The money moved; freeze the named wallet and inspect the ` +
          `other sender. Senders: ${emissions.map((e) => e.from ?? 'unknown').join(', ')}.`,
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

  start(pollMs = 1000, deliverMs = 1000): void {
    // Failures are swallowed on purpose: the tail is a background reporter and
    // must never be able to stop the service that holds the wallets.
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => console.warn('chain-svc: event poll failed', (err as Error).message));
    }, pollMs);
    this.deliverTimer = setInterval(() => {
      void this.deliverOnce().catch((err) => console.warn('chain-svc: event delivery failed', (err as Error).message));
    }, deliverMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.deliverTimer) clearInterval(this.deliverTimer);
    this.pollTimer = null;
    this.deliverTimer = null;
  }
}
