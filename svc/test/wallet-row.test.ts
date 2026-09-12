// The wallet row: `kind` recorded at spawn, and a platform-scope read for it.
//
// EVERY FIELD IN THIS RESPONSE WAS WRITE-ONLY BEFORE IT. `kind` is recorded at
// spawn, `frozen` is set by retirement and cleared only by PATCH /policy, and
// `bareIdCount` is incremented by the §5 detector - and the only way to see any
// of them was to open the sqlite file. That is the same defect the bare-id
// counter shipped with: a value nothing surfaces is not yet a signal. The
// column and the endpoint are one change because the endpoint is the column's
// only reader.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { SCHEMA_VERSION } from '../src/migrate.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'walletrow-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const dbPath = () => join(dir, 'store.sqlite');

describe('the wallet row records the kind that was enforced', () => {
  it('round-trips each kind', () => {
    const s = new Store(dbPath());
    s.markSpawned('arena:o', '0x' + '1'.repeat(40), 'org');
    s.markSpawned('arena:a', '0x' + '2'.repeat(40), 'agent');
    s.markSpawned('arena:b', '0x' + '3'.repeat(40), 'burner');
    expect(s.walletRow('arena:o')?.kind).toBe('org');
    expect(s.walletRow('arena:a')?.kind).toBe('agent');
    expect(s.walletRow('arena:b')?.kind).toBe('burner');
    s.close();
  });

  it('answers null for a wallet that was never spawned', () => {
    const s = new Store(dbPath());
    expect(s.walletRow('arena:ghost')).toBeNull();
    s.close();
  });

  // A wallet that recorded no kind reads null, NOT a guess. `null` and
  // `'agent'` are different facts and the column exists to keep them apart.
  it('reports an unrecorded kind as null rather than inferring one', () => {
    const s = new Store(dbPath());
    s.markSpawned('arena:old', '0x' + '4'.repeat(40), null);
    expect(s.walletRow('arena:old')?.kind).toBeNull();
    s.close();
  });
});

describe('the v4 upgrade', () => {
  // THE TRAP THE RULING EXISTS TO PREVENT. A store upgraded from v3 has rows
  // that predate the column; they must read NULL. `parseKind` returns 'agent'
  // for a missing value, so `NOT NULL DEFAULT 'agent'` would look correct and
  // would convert "we did not record this" into "this was an agent" -
  // indistinguishable from a measurement, permanently, in an audit column.
  it('leaves pre-migration rows NULL, not backfilled', () => {
    const path = dbPath();
    const s1 = new Store(path);
    s1.markSpawned('arena:before', '0x' + '5'.repeat(40), 'org');
    s1.close();

    // Make it look like a v3 store that never had the column.
    const db = new Database(path);
    db.exec('ALTER TABLE spawns DROP COLUMN kind');
    db.exec('PRAGMA user_version = 3');
    db.close();

    const s2 = new Store(path);
    expect(s2.walletRow('arena:before')?.kind).toBeNull();
    expect(s2.walletRow('arena:before')?.address).toBe('0x' + '5'.repeat(40));
    s2.close();

    const after = new Database(path);
    expect((after.query('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(SCHEMA_VERSION);
    after.close();
  });

  // The deferral's trigger, asserted as the query the comment names - so the
  // condition is evaluable rather than a belief about the world.
  it('exposes the null count as a single query', () => {
    const path = dbPath();
    const s = new Store(path);
    s.markSpawned('arena:withkind', '0x' + '6'.repeat(40), 'agent');
    s.markSpawned('arena:without', '0x' + '7'.repeat(40), null);
    s.close();

    const db = new Database(path);
    const n = (db.query('SELECT COUNT(*) AS n FROM spawns WHERE kind IS NULL').get() as { n: number }).n;
    db.close();
    expect(n).toBe(1);
  });
});
