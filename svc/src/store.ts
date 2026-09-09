// chain-svc's local durable state (spec S4): the things that have no on-chain
// home. Three of them, each here for a specific reason:
//
//   memos   - ERC-20 `transfer` carries no memo field, but /history must return
//             one, so the memo is joined on by txHash after the fact.
//   frozen  - the single source of truth for whether a wallet may spend.
//             /sign-transfer checks ONLY this. The per-agent POLICY_FILE that
//             wallet-mcp reads is a local fast-path copy; if the two ever
//             disagree, this table wins (spec S4).
//   outbox  - hub-core does not exist until C5, so chain events are buffered
//             here and retried rather than dropped.
//
// RUNTIME NOTE: `bun:sqlite` makes this package bun-only. Spec S4 says svc and
// wallet-mcp are "Node-22-compatible ESM ... either bun or node runs them",
// which cannot hold together with a sqlite requirement: node's `node:sqlite` is
// behind --experimental-sqlite on 22. chain-svc runs in its own image, which is
// built on bun, so this is contained - but it is a real conflict in the spec
// and is flagged in the C2a PR rather than papered over.

import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

/// Bounded so a hub-core that is down (or absent, pre-C5) cannot fill the disk.
/// Oldest are dropped first and the count is returned so the caller can log it:
/// a silently truncated audit trail is worse than a noisy one.
export const MAX_BUFFERED_EVENTS = 10_000;

export interface MemoRecord {
  txHash: string;
  memo: string | null;
  intentId: string | null;
  fromAgentId: string | null;
}

export interface OutboundEvent {
  id: number;
  kind: string;
  payload: string;
  attempts: number;
}

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    // WAL so a reader (/history) is never blocked by the events writer.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        tx_hash       TEXT PRIMARY KEY,
        memo          TEXT,
        intent_id     TEXT,
        from_agent_id TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frozen (
        agent_id  TEXT PRIMARY KEY,
        frozen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL,
        payload         TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- memos -------------------------------------------------------------

  recordMemo(rec: MemoRecord): void {
    this.db
      .query(
        `INSERT INTO memos (tx_hash, memo, intent_id, from_agent_id, created_at)
         VALUES ($tx, $memo, $intent, $from, $now)
         ON CONFLICT(tx_hash) DO NOTHING`,
      )
      .run({
        $tx: rec.txHash.toLowerCase(),
        $memo: rec.memo,
        $intent: rec.intentId,
        $from: rec.fromAgentId,
        $now: Date.now(),
      });
  }

  memosFor(txHashes: string[]): Map<string, MemoRecord> {
    const out = new Map<string, MemoRecord>();
    if (txHashes.length === 0) return out;
    const placeholders = txHashes.map(() => '?').join(',');
    const rows = this.db
      .query(`SELECT tx_hash, memo, intent_id, from_agent_id FROM memos WHERE tx_hash IN (${placeholders})`)
      .all(...txHashes.map((h) => h.toLowerCase())) as Array<{
      tx_hash: string;
      memo: string | null;
      intent_id: string | null;
      from_agent_id: string | null;
    }>;
    for (const r of rows) {
      out.set(r.tx_hash, { txHash: r.tx_hash, memo: r.memo, intentId: r.intent_id, fromAgentId: r.from_agent_id });
    }
    return out;
  }

  // --- frozen ------------------------------------------------------------

  freeze(agentId: string): void {
    this.db
      .query(`INSERT INTO frozen (agent_id, frozen_at) VALUES (?, ?) ON CONFLICT(agent_id) DO NOTHING`)
      .run(agentId, Date.now());
  }

  isFrozen(agentId: string): boolean {
    return this.db.query(`SELECT 1 AS present FROM frozen WHERE agent_id = ?`).get(agentId) != null;
  }

  // --- outbox ------------------------------------------------------------

  /// @returns how many events were dropped to stay under the cap (0 normally).
  enqueueEvent(kind: string, payload: unknown): number {
    this.db
      .query(`INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)`)
      .run(kind, JSON.stringify(payload), Date.now());

    const count = (this.db.query(`SELECT COUNT(*) AS n FROM outbox`).get() as { n: number }).n;
    if (count <= MAX_BUFFERED_EVENTS) return 0;

    const excess = count - MAX_BUFFERED_EVENTS;
    this.db.query(`DELETE FROM outbox WHERE id IN (SELECT id FROM outbox ORDER BY id ASC LIMIT ?)`).run(excess);
    return excess;
  }

  dueEvents(limit: number, now = Date.now()): OutboundEvent[] {
    return this.db
      .query(
        `SELECT id, kind, payload, attempts FROM outbox
         WHERE next_attempt_at <= ? ORDER BY id ASC LIMIT ?`,
      )
      .all(now, limit) as OutboundEvent[];
  }

  eventDelivered(id: number): void {
    this.db.query(`DELETE FROM outbox WHERE id = ?`).run(id);
  }

  /// Exponential backoff, capped: a sink that is down for an hour must not
  /// produce an hour of retry traffic, and must not stall forever either.
  eventFailed(id: number, now = Date.now()): void {
    const row = this.db.query(`SELECT attempts FROM outbox WHERE id = ?`).get(id) as { attempts: number } | null;
    if (!row) return;
    const attempts = row.attempts + 1;
    const delay = Math.min(2 ** Math.min(attempts, 10) * 1000, 5 * 60_000);
    this.db.query(`UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?`).run(attempts, now + delay, id);
  }

  pendingEventCount(): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM outbox`).get() as { n: number }).n;
  }
}
