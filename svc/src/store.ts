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

export type Reservation =
  | { outcome: 'reserved'; txHash: null }
  | { outcome: 'over_stage_cap'; txHash: null }
  | { outcome: 'duplicate'; txHash: string | null };

import { migrate } from './migrate.ts';
import type { DeploymentIdentity } from './deployment.ts';
import type { WalletKind } from './policy.ts';

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
    // Ordering is migrate()'s to enforce, not this constructor's - see migrate.ts.
    migrate(this.db, () => this.db.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        tx_hash       TEXT PRIMARY KEY,
        memo          TEXT,
        -- Denormalised for /history only. This column is NOT the dedupe key and
        -- never was: it is written AFTER the transfer, so a crash between the
        -- two loses it, and it is the 'intents' table below - written BEFORE -
        -- that decides whether a send may happen at all.
        intent_id     TEXT,
        from_agent_id TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spawns (
        agent_id   TEXT PRIMARY KEY,
        address    TEXT NOT NULL,
        -- The kind ENFORCED at spawn (the post-parseKind value), or NULL for a
        -- wallet spawned before this column existed. Nothing can reconstruct it
        -- afterwards: org and agent take the identical registration branch, and
        -- caps are a patch over tunable defaults. See migrate.ts for why NULL
        -- must stay NULL.
        kind       TEXT,
        -- §5's bare-id detector. Counts, never accumulates: a log of every bare
        -- send would be keyed on caller behaviour and grow forever, and the
        -- retention rule forbids exactly that. A counter bounded by this table has
        -- no retention window to get wrong.
        bare_id_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frozen (
        agent_id  TEXT PRIMARY KEY,
        frozen_at INTEGER NOT NULL
      );
      -- One live credential per wallet. Rotation REPLACES the row, which is
      -- what revokes the old token: there is no list of valid-but-superseded
      -- tokens to forget to clean up.
      CREATE TABLE IF NOT EXISTS wallet_tokens (
        agent_id   TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        issued_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS wallet_tokens_hash ON wallet_tokens (token_hash);
      -- The stage cap resets when the stage changes, so spend is tracked PER
      -- stage rather than being zeroed on transition: a late-arriving transfer
      -- from the previous stage cannot then overdraw the new one.
      -- An intent is RESERVED before the money moves and is never deleted.
      -- intent_id is the PRIMARY KEY, so a second attempt under the same id
      -- cannot insert: that is the idempotency guarantee, and it lives on the
      -- side that cannot forget rather than in the persona's JSON ledger, which
      -- is only written after a successful response and so is empty in exactly
      -- the case it exists for.
      CREATE TABLE IF NOT EXISTS intents (
        intent_id  TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL,
        stage      TEXT NOT NULL,
        amount     TEXT NOT NULL,
        tx_hash    TEXT,
        -- The stage budget this intent HOLDS, in wei, or '0' when it took no
        -- hold (a platform-scope transfer). RECORDED rather than inferred: the
        -- refund used to be keyed on whether the DELETE removed a row, which
        -- was correct while every reservation held its amount and stopped being
        -- correct the moment capWei:null made 'an intent row exists'
        -- independent of 'a hold was taken'. Releasing a no-hold reservation
        -- refunded budget never taken, and the zero-clamp turned that overshoot
        -- into wiping the wallet's real spend.
        held_wei   TEXT NOT NULL DEFAULT '0',
        -- keccak256(bytes(intent_id)), the form the chain logs. Stored rather
        -- than derived on demand so the sweep can join an IntentTransfer back
        -- to the intent that authorised it, and so the derivation lives in ONE
        -- place (Treasury.intentTopic) rather than being repeated here.
        topic      TEXT,
        -- COUNT, DON'T ACCUMULATE. The number of IntentTransfer emissions the
        -- tail has seen for this intent, with the first one recorded inline.
        --
        -- A table of every emission would be keyed on CHAIN HISTORY and grow
        -- forever, and no retention window is safe for it: a second emission
        -- can arrive arbitrarily late, and that lateness IS the detector's
        -- premise. A counter is bounded by this table - growth already
        -- accepted - and has no window to get wrong.
        emissions  INTEGER NOT NULL DEFAULT 0,
        first_tx   TEXT,
        first_from TEXT,
        -- NO CURRENT CONSUMER. The chain head observed BEFORE the reservation.
        -- Nothing reads this column: the sweep's negative branch did, and the
        -- #34 NO-GO removed it. Kept because the reservation strictly precedes
        -- the broadcast, so tx_block >= head-at-reserve makes it a sound FLOOR
        -- for the recorded future nonce-based branch - and that value is
        -- IRRECOVERABLE if it is not stamped at reserve time. See the
        -- reservedAtBlock comment on reserve().
        reserved_at_block TEXT,
        -- Whether the intent id was CALLER-SUPPLIED or SERVER-GENERATED.
        -- Recorded because the anomaly needs it: a foreign emission under a
        -- model-chosen id is a guessable id being guessed, and under a
        -- a chain-svc:<uuid> it is not - different stories, and a facilitator
        -- should not need a second lookup to tell them apart.
        id_source  TEXT,
        created_at INTEGER NOT NULL
      );
      -- Only ever holds the SECOND and later emissions for one intent, so it is
      -- small by construction rather than by pruning.
      CREATE TABLE IF NOT EXISTS intent_anomalies (
        topic      TEXT NOT NULL,
        tx_hash    TEXT NOT NULL,
        from_addr  TEXT,
        seen_at    INTEGER NOT NULL,
        PRIMARY KEY (topic, tx_hash)
      );
      CREATE TABLE IF NOT EXISTS stage_spend (
        agent_id TEXT NOT NULL,
        stage    TEXT NOT NULL,
        spent    TEXT NOT NULL,
        PRIMARY KEY (agent_id, stage)
      );
      -- WHICH CHAIN THIS STORE BELONGS TO (spec S4: the store and the chain
      -- state share one lifetime). Recorded on the first boot that sees a
      -- deployment, and compared on every boot after.
      --
      -- The pair goes wrong in BOTH directions and we only detected one. #52
      -- refuses when the STORE is wiped beside a live chain; this is the same
      -- two artefacts the other way round - the chain replaced while the store
      -- survives - which leaves every spawn marker pointing at names that no
      -- longer exist on the new registry, and every wallet permanently
      -- unresolvable with no repair path.
      --
      -- IDENTITY, NOT NAMES. The obvious check - a spawn marker whose canonical
      -- name is unregistered - is the STEADY STATE OF A BURNER, which registers
      -- no names by design while still getting a marker. This asks the only
      -- question that matters instead: are these the same two artefacts they
      -- were? That also catches a chain SWAP, which a name check never could.
      CREATE TABLE IF NOT EXISTS deployment (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        chain_id       TEXT NOT NULL,
        veebux         TEXT NOT NULL,
        name_registry  TEXT NOT NULL,
        recorded_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stage_state (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        stage TEXT NOT NULL
      );
      -- How far the log tail has read. Persisted so a restart resumes rather
      -- than replaying every Transfer since genesis into the outbox.
      CREATE TABLE IF NOT EXISTS cursors (
        name  TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        kind            TEXT NOT NULL,
        payload         TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL
      );
    `), () => this.db.exec(`
      CREATE INDEX IF NOT EXISTS intents_topic ON intents (topic);
    `));
  }

  /// Whether any intent id has ever been consumed. Read once at startup by the
  /// ledger-lifetime control: an empty ledger beside a live game is the
  /// signature of a store-only wipe. See migrate.ts.
  intentsEmpty(): boolean {
    return this.db.query(`SELECT 1 FROM intents LIMIT 1`).get() === null;
  }

  /// How many wallets this store remembers spawning. The second half of the
  /// ledger-lifetime control's store fact: `intentsEmpty` is true for a wiped
  /// store AND for a live game that has not transferred yet, and only this
  /// tells them apart. See migrate.ts.
  ///
  /// `spawns` rather than `deployment`, `outbox` or `cursors`, and the reason
  /// is ordering, not taste: index.ts records the deployment BEFORE it runs the
  /// control, so a wiped store already has a deployment row by the time the
  /// question is asked. A table the boot path writes cannot answer whether the
  /// boot found anything. `spawns` is written only by a spawn request.
  walletsRecorded(): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM spawns`).get() as { n: number }).n;
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

  // --- spawns ------------------------------------------------------------
  // Written only once every step of a spawn has succeeded. A key file alone is
  // NOT proof of a finished spawn: if the process dies between writing the key
  // and funding the wallet, a retry that trusted the key file would return a
  // wallet with no money and no name, reporting success.

  /// `kind` is REQUIRED rather than optional, and `null` is a legitimate value.
  ///
  /// Optional would leave a silent forget-path: a future caller that omitted it
  /// would write NULL, which reads as "spawned before the column existed" - a
  /// false statement about when, produced by an oversight. Required forces every
  /// site to say what it means, and a fixture passing `null` is stating
  /// truthfully that it recorded no kind.
  markSpawned(agentId: string, address: string, kind: WalletKind | null): void {
    this.db
      .query(
        `INSERT INTO spawns (agent_id, address, kind, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO NOTHING`,
      )
      .run(agentId, address, kind, Date.now());
  }

  /// The wallet row, for the platform-scope read. Null when nothing was ever
  /// spawned under that id.
  ///
  /// `kind` is `WalletKind | null` and the null is NOT filled in here or
  /// anywhere downstream - a consumer seeing null learns that this wallet
  /// predates the column, which is a different fact from any kind it might
  /// plausibly have been.
  walletRow(agentId: string): { address: string; kind: WalletKind | null; bareIdCount: number } | null {
    const row = this.db
      .query(`SELECT address, kind, bare_id_count FROM spawns WHERE agent_id = ?`)
      .get(agentId) as { address: string; kind: string | null; bare_id_count: number } | null;
    if (!row) return null;
    return {
      address: row.address,
      kind: row.kind === null ? null : (row.kind as WalletKind),
      bareIdCount: row.bare_id_count,
    };
  }

  spawnedAddress(agentId: string): string | null {
    const row = this.db.query(`SELECT address FROM spawns WHERE agent_id = ?`).get(agentId) as
      | { address: string }
      | null;
    return row?.address ?? null;
  }

  // --- which chain this store belongs to (spec S4) --------------------------

  /// The deployment this store was first used against, or null on a store that
  /// has never seen one.
  recordedDeployment(): DeploymentIdentity | null {
    const row = this.db
      .query(`SELECT chain_id, veebux, name_registry FROM deployment WHERE id = 1`)
      .get() as { chain_id: string; veebux: string; name_registry: string } | null;
    return row
      ? { chainId: row.chain_id, veeBux: row.veebux, nameRegistry: row.name_registry }
      : null;
  }

  /// Written ONCE, on the first boot that sees a deployment. Never updated by
  /// an acknowledgement: acknowledging a disagreement permits a boot, it does
  /// not make the two artefacts agree. Updating it is repair's job, at the
  /// point where "these now agree" becomes a true statement.
  recordDeployment(id: DeploymentIdentity): void {
    this.db
      .query(
        `INSERT INTO deployment (id, chain_id, veebux, name_registry, recorded_at)
         VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(id.chainId, id.veeBux, id.nameRegistry, Date.now());
  }

  // --- the bare-id detector (spec S5) --------------------------------------

  /// Counts one wallet-scope `to` that had no colon and was NOT an exactly
  /// registered name.
  ///
  /// THIS EXISTS BECAUSE §5 DELETED A DETECTOR. `unknown_name` used to be the
  /// only signal that a persona addresses peers by the id it SEES rather than
  /// the id the registry HOLDS; accepting the untaught form silences it, and a
  /// persona that never learns would then produce no signal at all. Same shape
  /// as on-chain dedupe silencing `chain.anomaly` (§4): the change cannot stop
  /// the behaviour, only stop recording it.
  ///
  /// REMOVING THIS COUNTER DELETES THE DETECTOR. It is not dead weight because
  /// nothing in the service reads it - the facilitator does.
  ///
  /// It counts the BEHAVIOUR, not one of its outcomes: a bare `to` counts
  /// whether the namespace fallback then succeeded, was skipped for shape, or
  /// failed - so it keeps firing exactly as `unknown_name` did, and a
  /// mixed-case persona stays visible. It does NOT count a legitimate
  /// colon-less alias or platform name (`treasury.vee`), because those are an
  /// exact hit and using them is correct.
  countBareId(agentId: string): void {
    this.db
      .query(`UPDATE spawns SET bare_id_count = bare_id_count + 1 WHERE agent_id = ?`)
      .run(agentId);
  }

  bareIdCount(agentId: string): number {
    const row = this.db
      .query(`SELECT bare_id_count FROM spawns WHERE agent_id = ?`)
      .get(agentId) as { bare_id_count: number } | null;
    return row?.bare_id_count ?? 0;
  }

  // --- frozen ------------------------------------------------------------

  freeze(agentId: string): void {
    this.db
      .query(`INSERT INTO frozen (agent_id, frozen_at) VALUES (?, ?) ON CONFLICT(agent_id) DO NOTHING`)
      .run(agentId, Date.now());
  }

  /// The ONLY way back from frozen (spec S3). `DELETE /wallets` still means
  /// retirement and is not reversible by this - retirement also clears the
  /// wallet's aliases, so un-freezing a retired wallet would give back the
  /// ability to spend without giving back the ability to be paid.
  unfreeze(agentId: string): void {
    this.db.query(`DELETE FROM frozen WHERE agent_id = ?`).run(agentId);
  }

  isFrozen(agentId: string): boolean {
    return this.db.query(`SELECT 1 AS present FROM frozen WHERE agent_id = ?`).get(agentId) != null;
  }

  // --- wallet credentials -------------------------------------------------

  setWalletTokenHash(agentId: string, tokenHash: string): void {
    this.db
      .query(
        `INSERT INTO wallet_tokens (agent_id, token_hash, issued_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET token_hash = excluded.token_hash, issued_at = excluded.issued_at`,
      )
      .run(agentId, tokenHash, Date.now());
  }

  hasWalletToken(agentId: string): boolean {
    return this.db.query(`SELECT 1 FROM wallet_tokens WHERE agent_id = ?`).get(agentId) != null;
  }

  /// The principal a wallet token identifies, or null if it is not a live one.
  agentForTokenHash(tokenHash: string): string | null {
    const row = this.db.query(`SELECT agent_id FROM wallet_tokens WHERE token_hash = ?`).get(tokenHash) as
      | { agent_id: string }
      | null;
    return row?.agent_id ?? null;
  }

  // --- stage and per-stage spend ------------------------------------------

  currentStage(): string {
    const row = this.db.query(`SELECT stage FROM stage_state WHERE id = 1`).get() as { stage: string } | null;
    return row?.stage ?? 'default';
  }

  setStage(stage: string): void {
    this.db
      .query(`INSERT INTO stage_state (id, stage) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET stage = excluded.stage`)
      .run(stage);
  }

  spentThisStage(agentId: string, stage: string): bigint {
    const row = this.db.query(`SELECT spent FROM stage_spend WHERE agent_id = ? AND stage = ?`).get(agentId, stage) as
      | { spent: string }
      | null;
    return row ? BigInt(row.spent) : 0n;
  }

  /// What a reservation attempt did.
  ///
  ///   reserved       - the caller owns this intent and may broadcast.
  ///   over_stage_cap - the cap would be exceeded; NOTHING was written.
  ///   duplicate      - this intent id was already reserved. `txHash` is the
  ///                    result of the original send if it completed, and null
  ///                    if it did not - which is not a failure to retry but a
  ///                    reconciliation: the first attempt may have broadcast.
  ///
  /// Atomically RESERVE `amount` against the stage cap.
  ///
  /// The check and the record are one step on purpose. They used to be two: the
  /// caller read the running total, did four awaits (name resolution, a scrypt
  /// keystore load, the chain write, the receipt wait) and then wrote the new
  /// total. Every concurrent send therefore read the same pre-spend figure and
  /// every one passed the cap - measured by sec-reviewer-2 at three concurrent
  /// 100-VEE sends against a 100/stage cap: three accepted, 300 recorded, three
  /// on chain, while the sequential fourth correctly refused. A cap enforced by
  /// a check-then-act is not a cap, it is a race the honest caller loses.
  ///
  /// @returns false if the reservation would exceed the cap, in which case
  /// nothing was written.
  reserve(args: {
    intentId: string;
    /// keccak256 of the intent id, as the chain logs it. See the `topic` column.
    topic?: string;
    /// The chain head observed BEFORE this reservation. See the column.
    reservedAtBlock?: bigint;
    /// 'caller' or 'server'. See the `id_source` column.
    idSource?: 'caller' | 'server';
    agentId: string;
    stage: string;
    amount: bigint;
    /// The stage cap to test against, or NULL for no cap hold at all - which
    /// is what a PLATFORM-scope transfer takes (harness spec S3). The intent is
    /// still recorded, so idempotency and the IntentTransfer story are
    /// unchanged; only the budget half is skipped, because the treasury has no
    /// stage cap and an operator reset refused as over_stage_cap mid-game would
    /// be a bad failure.
    ///
    /// This is the one place the primitive's two halves come apart, and it is a
    /// PARAMETER rather than a second method so that both halves stay in one
    /// transaction and the call site has to say which it wants.
    capWei: bigint | null;
  }): Reservation {
    const { intentId, topic, reservedAtBlock, idSource, agentId, stage, amount, capWei } = args;

    // ONE transaction covering BOTH the intent and the cap, because they are
    // one decision: "may this send happen". Two transactions would admit a
    // window where the intent is taken and the budget is not, or the reverse.
    const attempt = this.db.transaction((): Reservation => {
      const existing = this.db
        .query(`SELECT tx_hash FROM intents WHERE intent_id = ?`)
        .get(intentId) as { tx_hash: string | null } | null;
      if (existing) return { outcome: 'duplicate', txHash: existing.tx_hash };

      // Re-read INSIDE the transaction: a value read before it began is the
      // same stale figure the check-then-act acted on.
      const current = this.spentThisStage(agentId, stage);
      if (capWei !== null && current + amount > capWei) {
        return { outcome: 'over_stage_cap', txHash: null };
      }

      this.db
        .query(
          `INSERT INTO intents (intent_id, agent_id, stage, amount, tx_hash, held_wei, topic,
                                reserved_at_block, id_source, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          intentId,
          agentId,
          stage,
          amount.toString(),
          capWei === null ? '0' : amount.toString(),
          topic ?? null,
          reservedAtBlock === undefined ? null : reservedAtBlock.toString(),
          idSource ?? null,
          Date.now(),
        );
      if (capWei !== null) {
        this.db
          .query(
            `INSERT INTO stage_spend (agent_id, stage, spent) VALUES (?, ?, ?)
             ON CONFLICT(agent_id, stage) DO UPDATE SET spent = excluded.spent`,
          )
          .run(agentId, stage, (current + amount).toString());
      }
      return { outcome: 'reserved', txHash: null };
    });
    return attempt();
  }

  /// A FAILED INTENT MUST TOMBSTONE, NEVER DELETE - a standing invariant, not a
  /// note about the method that used to be here.
  ///
  /// There was a `failIntent` that called `release`, and `release` deletes the
  /// row. So marking an intent failed FREED ITS IDEMPOTENCY KEY, and the
  /// caller's correct retry under that id broadcast a second transfer. That is
  /// the double-charge this whole mechanism exists to prevent, and it was
  /// independent of the bug that triggered it: any future path that concludes
  /// "this did not land" and deletes the row reintroduces it.
  ///
  /// THE IDEMPOTENCY KEY'S LIFETIME IS THE GAME'S, REGARDLESS OF OUTCOME. A
  /// failed intent must keep its row and its id, give back only the HOLD, and
  /// answer a retry with a refusal. `release` is for the pre-broadcast case
  /// alone, where deleting is correct BECAUSE nothing was sent - the id was
  /// never spent against, so it is free to reuse.

  /// Records the result of a send against the intent that authorised it, so a
  /// retry can be answered with the original transaction rather than a second
  /// one.
  completeIntent(intentId: string, txHash: string): void {
    this.db.query(`UPDATE intents SET tx_hash = ? WHERE intent_id = ?`).run(txHash, intentId);
  }

  /// THERE IS DELIBERATELY NO TIMED SWEEP OF STALE HOLDS, and this is the
  /// second time that idea has been proposed and withdrawn - so here is why, to
  /// stop it being reinvented.
  ///
  /// A crash between the reservation and the recorded hash leaves an intent
  /// `reserved` with its stage budget held, and releasing that hold after a
  /// timeout looks like obvious hygiene. It is a CAP BYPASS. A `reserved`
  /// intent may have LANDED with its hash lost; releasing its hold hands back
  /// budget that was really spent, and lets the wallet spend it again. That is
  /// the one direction a cap must never err in.
  ///
  /// It is also the exact rule this file already enforces one screen up:
  /// release only on a failure that PROVABLY precedes the broadcast. A
  /// `reserved` intent is by definition not that. A sweep would have been the
  /// second release path the release rule exists to forbid, wearing a timer
  /// instead of a catch.
  ///
  /// So the hold is KEPT until the stage rolls over, which frees it because
  /// spend is keyed by (agent, stage). The wallet over-counts for a
  /// maybe-landed transfer. That is the conservative direction and it is the
  /// correct one.
  ///
  /// This becomes answerable, not merely conservative, once VEEBux emits
  /// IntentTransfer: the sweep can then resolve each reserved intent by event
  /// scan - landed means confirm and KEEP the hold, provably not landed means
  /// fail and release - so hold release and intent resolution become one
  /// decision, because "did the transfer land?" is one question. ruled
  /// UTC; the contract change rides the post-#14 PR.

  /// The whole reservation row, for reconciliation (spec S4 "Intents").
  intentRecord(intentId: string): {
    agentId: string;
    txHash: string | null;
    emissions: number;
    firstTx: string | null;
    firstFrom: string | null;
  } | null {
    const row = this.db
      .query(`SELECT agent_id, tx_hash, emissions, first_tx, first_from FROM intents WHERE intent_id = ?`)
      .get(intentId) as
      | { agent_id: string; tx_hash: string | null; emissions: number; first_tx: string | null; first_from: string | null }
      | null;
    return row
      ? {
          agentId: row.agent_id,
          txHash: row.tx_hash,
          emissions: row.emissions,
          firstTx: row.first_tx,
          firstFrom: row.first_from,
        }
      : null;
  }

  /// Records one IntentTransfer against the intent that authorised it, and
  /// answers whether THIS emission makes the intent anomalous.
  ///
  /// Only emissions matching an intent WE RESERVED are counted (ruled).
  /// An id nobody here reserved is another party's traffic on a shared chain,
  /// or a direct caller moving their own funds under a self-chosen id - neither
  /// is the game's double-spend, which is reusing a RESERVED allotment to land
  /// the same authorised spend twice. The split-brain case stays inside the
  /// scope: a retry carries the idempotency key, so BOTH stores reserve the
  /// same intent id and each one's count reaches two.
  ///
  /// Idempotent on (topic, txHash): the tail can re-see a block without
  /// double-counting, which matters because the cursor is only advanced after
  /// a successful pass.
  recordEmission(args: {
    topic: string;
    txHash: string;
    from: string | null;
  }): {
    anomalous: boolean;
    /// `repeat_emission` - two or more for one intent; `foreign_sender` - an
    /// emission under our intent id from an address that is not the reserving
    /// wallet. Different causes, different instructions to the facilitator.
    reason: 'repeat_emission' | 'foreign_sender';
    agentId: string;
    /// 'caller', 'server', or null for a row written before the column existed.
    idSource: string | null;
    emissions: number;
    transfers: Array<{ txHash: string; from: string | null }>;
  } | null {
    const { topic, txHash, from } = args;
    const apply = this.db.transaction(() => {
      const intent = this.db
        .query(`SELECT intent_id, agent_id, emissions, first_tx, first_from, id_source FROM intents WHERE topic = ?`)
        .get(topic) as
        | {
            intent_id: string;
            agent_id: string;
            emissions: number;
            first_tx: string | null;
            first_from: string | null;
            id_source: string | null;
          }
        | null;
      if (!intent) return null; // not an intent this store reserved

      // Already counted this exact emission.
      if (intent.first_tx === txHash) return null;
      const already = this.db
        .query(`SELECT 1 AS present FROM intent_anomalies WHERE topic = ? AND tx_hash = ?`)
        .get(topic, txHash);
      if (already) return null;

      if (intent.emissions === 0) {
        this.db
          .query(`UPDATE intents SET emissions = 1, first_tx = ?, first_from = ? WHERE topic = ?`)
          .run(txHash, from, topic);

        // A FIRST emission is normal - unless it came from somewhere else.
        // `transferWithIntent` is permissionless, so an IntentTransfer under
        // our id from an address that is not the reserving wallet is somebody
        // spending against our intent, not our transfer landing. That is an
        // anomaly on the first emission, and it is why the positive branch of
        // the sweep must constrain the sender as well as the id.
        const wallet = this.spawnedAddress(intent.agent_id);
        if (wallet && from && from.toLowerCase() !== wallet.toLowerCase()) {
          return {
            anomalous: true,
            reason: 'foreign_sender' as const,
            agentId: intent.agent_id,
            idSource: intent.id_source,
            emissions: 1,
            transfers: [{ txHash, from }],
          };
        }
        return null;
      }

      this.db
        .query(`INSERT INTO intent_anomalies (topic, tx_hash, from_addr, seen_at) VALUES (?, ?, ?, ?)`)
        .run(topic, txHash, from, Date.now());
      const emissions = intent.emissions + 1;
      this.db.query(`UPDATE intents SET emissions = ? WHERE topic = ?`).run(emissions, topic);

      const extras = this.db
        .query(`SELECT tx_hash, from_addr FROM intent_anomalies WHERE topic = ? ORDER BY seen_at`)
        .all(topic) as Array<{ tx_hash: string; from_addr: string | null }>;

      return {
        anomalous: true,
        reason: 'repeat_emission' as const,
        agentId: intent.agent_id,
        idSource: intent.id_source,
        emissions,
        transfers: [
          { txHash: intent.first_tx ?? '', from: intent.first_from },
          ...extras.map((e) => ({ txHash: e.tx_hash, from: e.from_addr })),
        ],
      };
    });
    return apply();
  }

  /// Ages a reservation, so a test can express a retention rule keyed on TIME
  /// rather than on stage. Test-only: every row a test creates is seconds old,
  /// so a wall-clock TTL is the one variant of "emission rows are immortal"
  /// that no ordinary fixture can reach.
  backdateIntentForTest(intentId: string, createdAt: number): void {
    this.db.query(`UPDATE intents SET created_at = ? WHERE intent_id = ?`).run(createdAt, intentId);
  }

  /// Intents this store reserved that have no recorded transaction, with the
  /// chain head observed before each reservation. The sweep's input.
  ///
  /// NO CURRENT CONSUMER. `reservedAtBlock` is recorded and read by nothing.
  ///
  /// Saying so plainly, because this comment used to claim it was "the lower
  /// bound that makes absence evidence" - true until the `#34` NO-GO removed
  /// the sweep's negative branch, which was its only reader. The writer, the
  /// column, the `observedHead` machinery feeding it, the SELECT and the
  /// justification all survived the removal of the thing they existed for.
  ///
  /// KEPT DELIBERATELY, and for a stronger reason than "a future branch might
  /// want it": the recorded future nonce-based negative branch needs the
  /// reserve-time head as its FLOOR - where scanning starts, the one thing a
  /// floor is for - and THAT VALUE IS IRRECOVERABLE IF NOT STAMPED AT RESERVE
  /// TIME. Deleting the column saves a write and throws away history that
  /// cannot be reconstructed later, so that PR would have to begin from a
  /// table which has never held one.
  ///
  /// It stays a sound floor because the reservation strictly precedes the
  /// broadcast: tx_block >= head at broadcast >= head at reserve. Null when the
  /// tail has not polled yet, and the future consumer must treat null as
  /// "cannot bound" rather than as zero - zero would make every absence look
  /// like evidence, which is the shape of the defect that removed the branch.
  unresolvedIntents(): Array<{
    intentId: string;
    topic: string | null;
    agentId: string;
    emissions: number;
    firstTx: string | null;
    firstFrom: string | null;
    reservedAtBlock: bigint | null;
  }> {
    // THE WORKING SET, not the whole table. Rows are NEVER deleted - the
    // idempotency key's lifetime is the game's - but the sweep only has work to
    // do for intents reserved in the CURRENT stage.
    //
    // A row whose stage has rolled over has already had its hold cleared by
    // construction, because stage spend is keyed by (agent_id, stage) and the
    // current stage's bucket is a different row. All that remains for it is a
    // best-effort positive resolve, which nobody is waiting on. Skipping it
    // bounds the sweep's COST without touching the table's contents: the table
    // still grows, and the id still answers `duplicate` for ever.
    //
    // A skip, not a retention delete. Those look similar and are opposites: one
    // stops doing work, the other destroys the record that makes a retry safe.
    const rows = this.db
      .query(
        `SELECT intent_id, topic, agent_id, emissions, first_tx, first_from, reserved_at_block
         FROM intents WHERE tx_hash IS NULL AND stage = ?`,
      )
      .all(this.currentStage()) as Array<{
      intent_id: string;
      topic: string | null;
      agent_id: string;
      emissions: number;
      first_tx: string | null;
      first_from: string | null;
      reserved_at_block: string | null;
    }>;
    return rows.map((r) => ({
      intentId: r.intent_id,
      topic: r.topic,
      agentId: r.agent_id,
      emissions: r.emissions,
      firstTx: r.first_tx,
      firstFrom: r.first_from,
      reservedAtBlock: r.reserved_at_block === null ? null : BigInt(r.reserved_at_block),
    }));
  }

  /// Which wallet reserved the intent the chain logged under this topic, for
  /// the anomaly payload. Null when the topic belongs to no reservation here -
  /// which is itself the interesting case, because it means the transfer came
  /// from somewhere this store has never seen.
  agentForIntentTopic(topic: string): string | null {
    const row = this.db.query(`SELECT agent_id FROM intents WHERE topic = ?`).get(topic) as
      | { agent_id: string }
      | null;
    return row?.agent_id ?? null;
  }

  intentTxHash(intentId: string): string | null {
    const row = this.db.query(`SELECT tx_hash FROM intents WHERE intent_id = ?`).get(intentId) as
      | { tx_hash: string | null }
      | null;
    return row?.tx_hash ?? null;
  }

  /// Give a reservation back — BOTH halves — when the send it was taken for
  /// PROVABLY did not happen.
  ///
  /// THE RELEASE RULE, and it is one rule for both halves on purpose: release
  /// only on a failure that provably PRECEDES the broadcast. Anything at or
  /// after it keeps the reservation and needs reconciliation against the chain.
  ///
  /// Reasoning about the two halves separately gives opposite answers, which is
  /// how this goes wrong: for the stage cap "release on error" reads obviously
  /// right, while for the intent releasing on error IS the double-spend —
  /// because "error" includes "it landed and the response was lost", which is
  /// the exact case an idempotency key exists for. The single rule is also the
  /// conservative direction for the cap: on an ambiguous outcome, keeping risks
  /// under-spending and releasing risks exceeding a boundary.
  ///
  /// If you find yourself writing a second release path that reasons about the
  /// intent separately from the cap, stop — that is the tell.
  /// Give a reservation back - BOTH halves - when the send it was taken for
  /// PROVABLY did not happen. See THE RELEASE RULE below.
  ///
  /// TAKES ONLY AN INTENT ID. Every other coordinate comes from the row: which
  /// wallet, which stage, how much was held. That is A1's principle finished
  /// rather than applied once - the first fix stopped trusting the caller's
  /// AMOUNT and went on trusting its idea of WHICH AGENT and WHICH STAGE, from
  /// the same SELECT that already knew both.
  ///
  /// Not reachable while `signTransfer` passes the same two variables to
  /// `reserve` and `release` - which is exactly where the previous guard sat
  /// before `capWei: null` existed. It separates for a second caller, for a
  /// caller whose stage moves mid-request (`currentStage()` can change once
  /// hub-core is configured), and for the scan-gated sweep, which by
  /// construction RECONSTRUCTS these coordinates instead of remembering them.
  release(intentId: string): void {
    const undo = this.db.transaction((): void => {
      const row = this.db
        .query(`SELECT agent_id, stage, held_wei FROM intents WHERE intent_id = ? AND tx_hash IS NULL`)
        .get(intentId) as { agent_id: string; stage: string; held_wei: string } | null;
      if (!row) return;

      // The `tx_hash IS NULL` here is REDUNDANT with the SELECT above, which
      // already returned for a completed intent - deliberately kept, because it
      // is the statement that would do the damage if the guard above ever moved
      // or changed shape. A mutation that removes it survives, and that is
      // correct rather than a coverage gap: it describes a change the code
      // cannot express while the early return stands.
      this.db.query(`DELETE FROM intents WHERE intent_id = ? AND tx_hash IS NULL`).run(intentId);

      const held = BigInt(row.held_wei);
      if (held > 0n) this.releaseStageSpend(row.agent_id, row.stage, held);
    });
    undo();
  }

  /// PRIVATE, and that is load-bearing rather than tidiness. `release` is the
  /// one door the release rule guards, and `treasury.ts` has a test asserting
  /// exactly one `.release(` call outside the pre-broadcast branch. That guard
  /// cannot see `.releaseStageSpend(` - `.release(` is not a substring of it -
  /// so while this was public a second post-broadcast refund path could be
  /// added and the structural test would stay green. One door, one guard.
  private releaseStageSpend(agentId: string, stage: string, amount: bigint): void {
    const release = this.db.transaction((): void => {
      const current = this.spentThisStage(agentId, stage);
      // Clamped at zero, and now UNREACHABLE BY CONSTRUCTION rather than
      // defence against a live path - recorded because the previous comment
      // implied a reachability that no longer exists.
      //
      // It could fire while `release` took the amount from its CALLER: naming
      // more than was reserved drove the spend negative, and a negative spend
      // reads as the wallet owing budget, which admits MORE spending. A5 made
      // `release` derive the amount from the row, so the only caller now passes
      // exactly what was recorded and the subtraction cannot overshoot. Kept
      // because `releaseStageSpend` would be reachable again the moment
      // something else calls it with a figure of its own.
      const next = current > amount ? current - amount : 0n;
      this.db
        .query(
          `INSERT INTO stage_spend (agent_id, stage, spent) VALUES (?, ?, ?)
           ON CONFLICT(agent_id, stage) DO UPDATE SET spent = excluded.spent`,
        )
        .run(agentId, stage, next.toString());
    });
    release();
  }

  // --- cursors ------------------------------------------------------------

  /// The highest chain head the tail has OBSERVED, distinct from the cursor.
  ///
  /// The cursor says how far the tail has PROCESSED; this says how far it has
  /// LOOKED. Only the second is a sound lower bound for a reservation, and the
  /// difference is exactly the window a transfer lands in:
  ///
  ///     tx_block >= head at broadcast >= head at reserve >= observed head
  ///
  /// `cursor_now > cursor_at_reserve` does NOT imply the tail passed the
  /// transaction's block. `cursor_now >= observed_head_at_reserve` does.
  ///
  /// NO CURRENT CONSUMER. The one caller is `treasury.ts`'s reserve, which
  /// stamps `reserved_at_block`, which nothing reads - see that column. The
  /// arithmetic above is what the value MEANS, not a dependency anything has
  /// today; it is kept because the floor is irrecoverable after the fact.
  observedHead(): bigint | null {
    return this.getCursor('chain-observed-head');
  }

  setObservedHead(block: bigint): void {
    const current = this.observedHead();
    if (current === null || block > current) this.setCursor('chain-observed-head', block);
  }

  getCursor(name: string): bigint | null {
    const row = this.db.query(`SELECT value FROM cursors WHERE name = ?`).get(name) as { value: string } | null;
    return row ? BigInt(row.value) : null;
  }

  setCursor(name: string, value: bigint): void {
    this.db
      .query(`INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`)
      .run(name, value.toString());
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
