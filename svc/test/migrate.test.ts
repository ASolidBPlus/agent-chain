// Schema migration and the ledger-lifetime control.
//
// The fixtures here are STALE STORES, built column by column rather than by an
// older copy of the schema, because the defect being guarded is precisely that
// `CREATE TABLE IF NOT EXISTS` records nothing about the shape it created: a
// store stamped v0 may or may not have any given column, and which one it has
// depends only on which build first created its volume.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { Keystore } from '../src/keystore.ts';
import {
  SCHEMA_VERSION,
  SchemaError,
  ADDITIVE_COLUMNS,
  classifiedColumns,
  assertLedgerLifetimeIntact,
  gatherLifetimeFacts,
  LedgerWipeError,
  LEDGER_RESET_NOTICE,
  FREEZE_RECOVERY_ADVICE,
} from '../src/migrate.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chain-migrate-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const dbPath = () => join(dir, 'store.sqlite');

function userVersion(path: string): number {
  const db = new Database(path);
  const v = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  db.close();
  return v;
}

function columns(path: string, table: string): string[] {
  const db = new Database(path);
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

/// A store as an EARLIER build left it: `intents` without any of the columns
/// added since. This is the shape that produced `no such column: topic`.
function writeAncestralStore(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE intents (
    intent_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, stage TEXT NOT NULL,
    amount TEXT NOT NULL, tx_hash TEXT, created_at INTEGER NOT NULL)`);
  db.close();
}

describe('schema migration', () => {
  it('stamps a fresh store at the current version', () => {
    const s = new Store(dbPath());
    s.close();
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // The measured production failure: a persisted volume from before `topic`.
  // Before the migration this threw `no such column: topic` at the first query
  // to name it - long after startup had reported success.
  it('adds the missing columns to a store an older build created', () => {
    writeAncestralStore(dbPath());
    expect(columns(dbPath(), 'intents')).not.toContain('topic');

    const s = new Store(dbPath());
    const r = s.reserve({
      intentId: 'i1', agentId: 'orch:a', stage: s.currentStage(),
      amount: 10n, capWei: 100n, topic: '0xdead',
    });
    s.close();

    expect(r.outcome).toBe('reserved');
    for (const a of ADDITIVE_COLUMNS.filter((c) => c.table === 'intents')) {
      expect(columns(dbPath(), 'intents')).toContain(a.column);
    }
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // THE MONEY-RELEVANT ONE. The whole reason a migration exists rather than a
  // documented wipe: the consumed intent ids have to survive the upgrade, or
  // the upgrade IS the double-spend it was meant to avoid.
  it('carries consumed intent ids through the upgrade, so a replay still refuses', () => {
    writeAncestralStore(dbPath());
    const old = new Database(dbPath());
    old.query(
      `INSERT INTO intents (intent_id, agent_id, stage, amount, tx_hash, created_at)
       VALUES ('already-paid', 'orch:a', 's1', '5', '0xPAID', 0)`,
    ).run();
    old.close();

    const s = new Store(dbPath());
    const replay = s.reserve({
      intentId: 'already-paid', agentId: 'orch:a', stage: 's1', amount: 5n, capWei: 100n,
    });
    s.close();

    expect(replay).toEqual({ outcome: 'duplicate', txHash: '0xPAID' });
  });

  // THE FIRST SCHEMA CHANGE AFTER THE MIGRATION SHIPPED, and the case the
  // original gate got wrong: a store stamped v1 by the previous release skipped
  // the reconciliation entirely, because it was gated on `version === 0`. It
  // would have needed a numbered migration adding the same column the baseline
  // adds - two mechanisms owning one list of columns.
  it('upgrades a store stamped by the PREVIOUS release, not just a legacy one', () => {
    const s1 = new Store(dbPath());
    s1.close();
    const db = new Database(dbPath());
    db.exec('PRAGMA user_version = 1');            // as the previous release left it
    db.exec('ALTER TABLE spawns DROP COLUMN bare_id_count'); // ...without v2's column
    db.close();

    expect(columns(dbPath(), 'spawns')).not.toContain('bare_id_count');
    const s2 = new Store(dbPath());
    s2.close();

    expect(columns(dbPath(), 'spawns')).toContain('bare_id_count');
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // v0 IS AMBIGUOUS. A store created by a build that already had `topic` is
  // also stamped 0, and a baseline replaying a fixed history would either fail
  // on it or skip a column the other kind of v0 store needs.
  it('handles a v0 store that ALREADY has the added columns', () => {
    const s1 = new Store(dbPath());
    s1.close();
    const db = new Database(dbPath());
    db.exec('PRAGMA user_version = 0'); // a current shape, stamped as legacy
    db.close();

    expect(() => { new Store(dbPath()).close(); }).not.toThrow();
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });

  // The rollback direction. An older binary against a newer store must refuse
  // by name rather than discover it at the first unknown column.
  it('refuses a store written by a NEWER binary, naming the cause', () => {
    const db = new Database(dbPath(), { create: true });
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    let err: unknown;
    try { new Store(dbPath()); } catch (e) { err = e; }

    expect(err).toBeInstanceOf(SchemaError);
    expect((err as SchemaError).code).toBe('store_schema_ahead');
    expect((err as SchemaError).message).toContain(`v${SCHEMA_VERSION + 1}`);
    expect((err as SchemaError).message).toContain(LEDGER_RESET_NOTICE);
  });

  // "Before any write" is the actual requirement, not "before any query": a
  // binary that creates tables on its way to refusing has already modified a
  // store it admits it cannot read.
  it('writes NOTHING to a store it refuses', () => {
    const db = new Database(dbPath(), { create: true });
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    try { new Store(dbPath()); } catch { /* expected */ }

    const after = new Database(dbPath());
    const tables = after.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as { name: string }[];
    after.close();
    expect(tables).toEqual([]);
  });

  // The index is part of the schema contract and its creation is now sequenced
  // by the migration, so it needs an assertion of its own: a functional test
  // cannot see a missing index, because every query still returns the right
  // answer without it. Only slower.
  it('builds the topic index, on a fresh store and on a migrated one', () => {
    for (const seed of [() => {}, () => writeAncestralStore(dbPath())]) {
      rmSync(dbPath(), { force: true });
      seed();
      new Store(dbPath()).close();
      const db = new Database(dbPath());
      const idx = db.query(
        `SELECT name FROM sqlite_master WHERE type='index' AND name = 'intents_topic'`,
      ).get();
      db.close();
      expect(idx).not.toBeNull();
    }
  });

  // The forcing function for the NEXT person to add a column. Without it, a
  // column added to the DDL and not to ADDITIVE_COLUMNS ships green and breaks
  // only on somebody's persisted volume.
  it('classifies every column in the live schema as original or additive', () => {
    const s = new Store(dbPath());
    s.close();
    const db = new Database(dbPath());
    const tables = (db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as { name: string }[]).map((t) => t.name);

    const live = new Set<string>();
    for (const t of tables) {
      for (const c of db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]) {
        live.add(`${t}.${c.name}`);
      }
    }
    db.close();

    const classified = classifiedColumns();
    const unclassified = [...live].filter((c) => !classified.has(c)).sort();
    const stale = [...classified].filter((c) => !live.has(c)).sort();
    expect(unclassified).toEqual([]);
    expect(stale).toEqual([]);
  });
});

// THE FACTS, not just the decision. The control above is a pure function over
// three booleans and is thoroughly pinned - which proves nothing about whether
// the values handed to it are the ones it names. An inverted `intentsEmpty` or
// a keystore count that never counts would leave every test above green and
// the control permanently off.
describe('the facts the control is given', () => {
  it('intentsEmpty is true on a fresh store and false once an id is consumed', () => {
    const s = new Store(dbPath());
    expect(s.intentsEmpty()).toBe(true);
    s.reserve({ intentId: 'i1', agentId: 'orch:a', stage: s.currentStage(), amount: 1n, capWei: 10n });
    expect(s.intentsEmpty()).toBe(false);
    s.close();
  });

  // A store wiped beneath a live game is EMPTY, not absent - the file is
  // recreated by the next start. So the true case has to hold for a store that
  // exists and has tables, which is what makes it indistinguishable from a
  // fresh install WITHOUT the keystore conjunct.
  it('intentsEmpty stays true when other tables have rows', async () => {
    const s = new Store(dbPath());
    await s.markSpawned('orch:a', '0x1111111111111111111111111111111111111111', null);
    expect(s.intentsEmpty()).toBe(true);
    s.close();
  });

  // THE FACT THAT SEPARATES A WIPE FROM A RESTART, and the one whose absence
  // made `compose down && compose up` refuse to start. The reopen IS the
  // scenario: same file, new process, no transfer ever made in this game.
  it('walletsRecorded survives a restart that keeps the volume, while intents stays empty', () => {
    const p = dbPath();
    const s = new Store(p);
    expect(s.walletsRecorded()).toBe(0);
    s.markSpawned('orch:a', '0x1111111111111111111111111111111111111111', null);
    s.markSpawned('orch:b', '0x2222222222222222222222222222222222222222', null);
    expect(s.walletsRecorded()).toBe(2);
    s.close();

    const again = new Store(p);
    expect(again.walletsRecorded()).toBe(2);
    expect(again.intentsEmpty()).toBe(true); // the reason intents cannot answer this
    again.close();
  });

  // A WIPED store is recreated EMPTY, not absent - so the zero has to come from
  // a store that exists and has tables, which is the state being detected.
  it('walletsRecorded is zero on a store that was recreated from nothing', () => {
    const s = new Store(dbPath());
    expect(s.walletsRecorded()).toBe(0);
    s.close();
  });

  it('agentCount counts key files, and is zero with no directory at all', async () => {
    const ks = new Keystore(join(dir, 'no-such-keystore'), 'secret-secret-secret-secret');
    expect(await ks.agentCount()).toBe(0);
    await ks.create('orch:a');
    await ks.create('orch:b');
    expect(await ks.agentCount()).toBe(2);
  });

  // 0 IS NOT A NEUTRAL ANSWER: it is the exact value that switches the control
  // off. So an UNREADABLE keystore must not answer the same as an ABSENT one.
  //
  // This is the fact that failed open while its two siblings failed closed, and
  // the asymmetry pointed the wrong way: the scenario that trips the control is
  // an operator doing volume surgery, which is exactly when a neighbouring
  // volume can also fail to attach. The precondition broke in the same incident
  // the control exists to detect.
  it('PROPAGATES an unreadable keystore instead of reporting zero agents', async () => {
    const kdir = join(dir, 'locked');
    const ks = new Keystore(kdir, 'secret-secret-secret-secret');
    await ks.create('orch:a');
    chmodSync(kdir, 0o000);
    try {
      // The bare catch returned 0 here, which reads as "a fresh install".
      await expect(ks.agentCount()).rejects.toThrow();
    } finally {
      chmodSync(kdir, 0o700); // or the fixture cannot be cleaned up
    }
  });
});

// THE WIRING. Each fact is carried from its real source to the control, and a
// constant substituted for any one of them leaves every test above green while
// the control is permanently off - the shape that left #34's sweep dormant
// through a merge.
describe('gathering the facts', () => {
  const deps = (over: Partial<{ empty: boolean; wallets: number; agents: number; code: string | undefined; ack: boolean }> = {}) => ({
    store: { intentsEmpty: () => over.empty ?? true, walletsRecorded: () => over.wallets ?? 0 },
    keystore: { agentCount: async () => over.agents ?? 2 },
    getCode: async () => ('code' in over ? over.code : '0x6080'),
    acknowledged: over.ack ?? false,
  });

  it('carries each fact from its own source', async () => {
    expect(await gatherLifetimeFacts(deps())).toEqual({
      intentsEmpty: true, storeWallets: 0, keystoreAgents: 2, contractsDeployed: true, acknowledged: false,
    });
    expect((await gatherLifetimeFacts(deps({ empty: false }))).intentsEmpty).toBe(false);
    expect((await gatherLifetimeFacts(deps({ wallets: 4 }))).storeWallets).toBe(4);
    expect((await gatherLifetimeFacts(deps({ agents: 7 }))).keystoreAgents).toBe(7);
    expect((await gatherLifetimeFacts(deps({ ack: true }))).acknowledged).toBe(true);
  });

  // An address with no code answers '0x', not undefined - the case a reset
  // chain actually produces, and the one a truthiness check would get wrong.
  it('reads an undeployed contract from the CHAIN, both empty forms', async () => {
    expect((await gatherLifetimeFacts(deps({ code: '0x' }))).contractsDeployed).toBe(false);
    expect((await gatherLifetimeFacts(deps({ code: undefined }))).contractsDeployed).toBe(false);
  });
});

// THE SHARED SENTENCE ITSELF, pinned separately from every message that embeds
// it. It is an interface: the CLI wrappers and the harness Reset log import it,
// and an operator's acknowledgement is only informed consent if it names ALL of
// what is destroyed. It understated the cost by half once already, so the
// completeness is a test rather than a convention.
describe('the reset notice', () => {
  // ASSERTED ON ITS OWN CONTENT, not merely "the message contains it".
  // `toContain(SOME_CONSTANT)` is vacuously true when the constant is empty -
  // the same sentinel family as `-1 < anything`: an absent value satisfies the
  // check. Emptying FREEZE_RECOVERY_ADVICE survived every other test in this
  // file until this one existed.
  it('the recovery advice tells the operator what to actually do', () => {
    expect(FREEZE_RECOVERY_ADVICE).toContain('re-freeze');
    expect(FREEZE_RECOVERY_ADVICE).toContain('no record of what it was');
  });

  it('names both costs, as consequences rather than actions', () => {
    expect(LEDGER_RESET_NOTICE).toContain('reservable again');
    expect(LEDGER_RESET_NOTICE).toContain('may spend again');
    // "reset"/"cleared" read as housekeeping. The sentence must say what
    // becomes POSSIBLE, which is what an operator has to weigh.
    expect(LEDGER_RESET_NOTICE).not.toMatch(/\bresets?\b|\bcleared\b/i);
  });
});

// THE CALL SITE ITSELF, structurally - the repo's `.release(` idiom
// (spawn.test.ts), and deliberately so.
//
// ⚠ READ THIS BEFORE ADDING A GUARD HERE, AND DO NOT REACH FOR `indexOf`.
//
// One defect appeared at FOUR levels in this PR, and each fix reproduced it one
// layer out - every one a check that PASSES ON LESS THAN IT CLAIMS:
//
//   1. the control's wire had no test at all           (a constant at the call
//      site left the refusal dormant with the suite green)
//   2. the seam's structural types caught a LITERAL and accepted a plausible
//      STUB - the dangerous edit is the one that typechecks
//   3. this guard's block extraction used indexOf('})'), which cut the object
//      literal in half at the nested `getCode({...})` and read 3 of its 4 wires
//   4. the ordering guard below searched for the IDENTIFIER, which also appears
//      in the import, and so read 0 of 1 calls
//
// The common cause is not carelessness: each layer is a guard written quickly
// with the cheapest available string operation, AND `indexOf` IS PRECISELY THE
// OPERATION WHOSE FAILURE MODE IS SILENCE. It returns a number either way. A
// future guard here will reach for it again unless something says not to.
//
// TWO RULES THAT WOULD HAVE CAUGHT ALL FOUR:
//   - A COMPARISON WHOSE FAILURE VALUE IS ALSO ITS SUCCESS VALUE CANNOT BE A
//     CHECK. `indexOf`'s sentinel is -1, and -1 is less than everything, so
//     absence satisfies "comes before". Assert the index EXISTS, then compare.
//   - EVERY GUARD NEEDS A NULL MUTANT: delete the thing it guards and confirm
//     it reddens. Applied to the rest of this file it found one more of the
//     same family - `toContain(FREEZE_RECOVERY_ADVICE)` is vacuously true when
//     that constant is empty, so emptying it survived every test here.
//
// `gatherLifetimeFacts` was extracted BECAUSE a constant at the call site left
// the control dormant with the suite green. The structural parameter types then
// catch `intentsEmpty: false` - a LITERAL where a function belongs, TS2322.
// They do NOT catch `intentsEmpty: () => false`, `agentCount: async () => 0`,
// `getCode: async () => undefined` or `acknowledged: true`: each typechecks,
// each leaves 264 tests passing, and each disables the control.
//
// THE DANGEROUS EDIT IS THE ONE THAT TYPECHECKS. A literal substitution is what
// a mutation tester writes; a plausible STUB is what a developer writes when
// they extract, mock "temporarily", or refactor an entrypoint - and no test
// reaches index.ts to notice. So this asserts each fact is wired to its REAL
// source by name.
describe('the call site in index.ts', () => {
  it('wires every fact to its real source, not to a stub', async () => {
    const src = await Bun.file(new URL('../src/index.ts', import.meta.url)).text();
    const start = src.indexOf('gatherLifetimeFacts({');
    expect(start).toBeGreaterThan(-1);
    // Brace-balanced rather than up-to-the-first-`})`: the getCode wire contains
    // a nested object literal, so a naive slice cuts the block in half and drops
    // the very wire that follows it. (It did, first run - the guard was reading
    // three of the four facts and would have passed on a stubbed `acknowledged`.)
    let depth = 0;
    let end = start;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = src.slice(start, end);

    expect(block).toMatch(/\bstore,/);                              // the real Store
    expect(block).toMatch(/\bkeystore,/);                           // the real Keystore
    expect(block).toMatch(/getCode:\s*\(\)\s*=>\s*chain\.publicClient\.getCode\(/); // the real chain
    expect(block).toMatch(/acknowledged:\s*config\.acknowledgeLedgerReset/); // the real flag
  });

  // The refusal must precede anything that can move money. A control that runs
  // after the server is listening is a control that lost the race it exists for.
  //
  // TWO WAYS THIS ASSERTION WAS WRONG THE FIRST TIME, both of which made it
  // pass when the control was entirely absent:
  //
  // (1) It searched for `assertLedgerLifetimeIntact`, which also appears in the
  //     IMPORT at the top of the file - so it matched char 584 regardless of
  //     what happened to the call. THE IDENTIFIER IS NOT THE CALL SITE. Deleting
  //     the call, or moving it AFTER server.listen, both left it green.
  // (2) It compared indexOf results directly. indexOf's sentinel is -1, and
  //     `-1 < anything` is the SUCCESS condition - so ABSENCE READ AS CORRECT
  //     ORDERING. COMPARE TO A VALUE, NOT TO EMPTINESS: both indices have to
  //     exist before their order means anything.
  it('refuses BEFORE the server starts listening', async () => {
    const src = await Bun.file(new URL('../src/index.ts', import.meta.url)).text();
    const call = src.indexOf('gatherLifetimeFacts({'); // the call, not the import
    const listen = src.indexOf('server.listen');
    expect(call).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(call).toBeLessThan(listen);
  });
});

describe('the ledger lifetime control', () => {
  // Empty store + keys in the keystore + contracts on the chain. Each conjunct
  // rules out one legitimate way to arrive at an empty store, which is why
  // this is a proof rather than a heuristic.
  const wiped = { intentsEmpty: true, storeWallets: 0, keystoreAgents: 3, contractsDeployed: true, acknowledged: false };

  it('refuses a store wiped beneath a live game', () => {
    expect(() => assertLedgerLifetimeIntact(wiped)).toThrow(LedgerWipeError);
  });

  it('names both consequences and the way out', () => {
    let err: unknown;
    try { assertLedgerLifetimeIntact(wiped); } catch (e) { err = e; }
    const msg = (err as Error).message;
    expect(msg).toContain(LEDGER_RESET_NOTICE);
    expect(msg).toContain(FREEZE_RECOVERY_ADVICE);
    expect(msg).toContain('--acknowledge-ledger-reset');
  });

  // A FRESH INSTALL. No keystore files, because no agent has ever been
  // spawned - the conjunct that makes an empty store legitimate here.
  it('starts normally on a fresh install', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, keystoreAgents: 0 })).not.toThrow();
  });

  // AN HONEST FULL RESET. Fresh anvil, contracts not yet deployed.
  it('starts normally when the chain was reset with the store', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, contractsDeployed: false })).not.toThrow();
  });

  it('does not refuse once any intent has been consumed', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, intentsEmpty: false })).not.toThrow();
  });

  // A LIVE GAME THAT HAS SIMPLY NOT SPENT YET - the false positive that sent
  // this back. `compose down` followed by `compose up` keeps every volume: the
  // store returns with its spawns, its outbox and its wallet tokens, and an
  // intents table that is empty because no transfer has happened YET. The old
  // comment here said this case was caught deliberately and referred to a note
  // below justifying it; there was no note below, and once the stack restarts
  // routinely (#83) the refusal fires on an ordinary restart.
  //
  // It is distinguished by THE STORE BEING PRESENT, which is what this conjunct
  // now reads - and nothing else changed, so each of the cases below still
  // rules out one legitimate way to arrive at an empty store.
  it('starts normally when the store still remembers the wallets it spawned', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, storeWallets: 4 })).not.toThrow();
  });

  // The NULL MUTANT for the new conjunct: one wallet is enough to prove the
  // store survived, and a `>= 1` that drifted to `> 1` would pass the case
  // above and refuse a one-agent game.
  it('one remembered wallet is already proof the store survived', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, storeWallets: 1 })).not.toThrow();
  });

  // The legitimate reset stays ONE documented step.
  it('the acknowledgement releases it', () => {
    expect(() => assertLedgerLifetimeIntact({ ...wiped, acknowledged: true })).not.toThrow();
  });

  // The acknowledgement is the ONLY thing that releases a genuine wipe: a
  // mutant that returns early on any other conjunct alone would pass the tests
  // above and disable the control.
  it('the acknowledgement is not implied by any other fact', () => {
    expect(() => assertLedgerLifetimeIntact(wiped)).toThrow();
  });
});

// §8.6. THE FIRST NUMBERED MIGRATION, and the first one that RESHAPES a table
// rather than adding to it.
//
// A v4 store's `deployment` row held two address columns, because a deployment
// was exactly one token and one registry. A v5 store holds a JSON list, because
// it can be any number of modules in a declared order.
describe('the v4 -> v5 deployment reshape', () => {
  /// A v4 `deployment` table, built by running the OLD DDL by hand rather than
  /// by checking out the old code: the point is to migrate the shape the
  /// previous release actually wrote, and reconstructing it here is what makes
  /// this a test of the migration rather than of `createTables()`.
  function v4Store(path: string, chainId = '31337'): void {
    const s = new Store(path); // current shape, then reshaped back to v4
    s.close();
    const db = new Database(path);
    db.exec(`
      DROP TABLE deployment;
      CREATE TABLE deployment (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        chain_id       TEXT NOT NULL,
        veebux         TEXT NOT NULL,
        name_registry  TEXT NOT NULL,
        recorded_at    INTEGER NOT NULL
      );
      INSERT INTO deployment (id, chain_id, veebux, name_registry, recorded_at)
        VALUES (1, '${chainId}', '0xVEE', '0xREG', 1700000000000);
      PRAGMA user_version = 4;
    `);
    db.close();
  }

  it('carries the two addresses into the module list, in order', () => {
    v4Store(dbPath());

    const s = new Store(dbPath());
    const recorded = s.recordedDeployment();
    s.close();

    expect(recorded).toEqual({
      chainId: '31337',
      modules: [
        // 'vee' is not a fixture here: it is what the BACKFILL writes, because
        // that is the only key a v4 store could have meant.
        { kind: 'token', key: 'vee', address: '0xVEE' },
        { kind: 'names', address: '0xREG' },
      ],
    });
  });

  // THE BACKFILL IS TOTAL AND THAT IS WHY IT IS SOUND: every v4 store was
  // written by a build whose deployment row could only ever be one token and
  // one registry, so `vee` is the only key it could have meant. Nothing is
  // invented; the shape is just restated.
  it('stamps the store at 5, so a second boot does not refuse it as newer', () => {
    v4Store(dbPath());

    const first = new Store(dbPath());
    first.close();
    expect(userVersion(dbPath())).toBe(5);

    // The refusal this guards against is "written by a NEWER chain-svc": with
    // SCHEMA_VERSION left at 4, the first boot would stamp 5 and the second
    // would read 5 > 4 and refuse the store it had just migrated.
    const second = new Store(dbPath());
    second.close();
    expect(userVersion(dbPath())).toBe(5);
  });

  // A MIGRATED STORE AND A FRESH ONE MUST BE THE SAME STORE. Two paths reach
  // the v5 shape - `createTables()` for a new store and the numbered migration
  // for an old one - and nothing else would notice them drifting apart.
  it('lands on the same schema as a store created fresh', () => {
    v4Store(dbPath());
    const migrated = new Store(dbPath());
    migrated.close();
    const migratedColumns = columns(dbPath(), 'deployment');

    rmSync(dbPath(), { force: true });
    const fresh = new Store(dbPath());
    fresh.close();

    expect(migratedColumns).toEqual(columns(dbPath(), 'deployment'));
    expect(migratedColumns).toEqual(['id', 'chain_id', 'modules_json', 'recorded_at']);
  });

  // THE GUARD IS ON THE SCHEMA, NOT THE VERSION, and this is the case that
  // proves why. A fresh store is created at the v5 shape and stamped 0 until
  // the end of migrate(), so a `version < 5` guard fires the reshape against a
  // table that never had `veebux` - measured, `no such column: veebux`, on
  // every fresh store.
  // RE-ASSERTED AGAINST 5 EXPLICITLY, because the rule "a store from a newer
  // build is refused" is only meaningful relative to the CURRENT version, and
  // the v5 bump is exactly the kind of change that could have left the refusal
  // comparing against a stale constant.
  it('still refuses a store stamped by a build newer than this one', () => {
    const s = new Store(dbPath());
    s.close();
    const db = new Database(dbPath());
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    expect(SCHEMA_VERSION).toBe(5);
    expect(() => new Store(dbPath())).toThrow(/newer/i);
  });

  it('does not run the reshape on a fresh store, which never had the old columns', () => {
    const s = new Store(dbPath());
    s.recordDeployment({ chainId: '31337', modules: [{ kind: 'token', key: 'play', address: '0xA' }] });
    const recorded = s.recordedDeployment();
    s.close();

    expect(recorded?.modules).toEqual([{ kind: 'token', key: 'play', address: '0xA' }]);
    expect(userVersion(dbPath())).toBe(SCHEMA_VERSION);
  });
});
