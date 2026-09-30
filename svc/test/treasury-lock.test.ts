// TreasuryLock: one queue for every transaction the treasury key signs.
//
// These are the lock's own properties, run against the production class with
// real timers. That every treasury send site actually USES it is a separate
// claim, made structurally below and behaviourally in the concurrency test.
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { TreasuryLock } from '../src/chain.ts';
import { HttpError } from '../src/errors.ts';
import { blankComments } from './support/source.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// A send that records when it is in flight, and fails the test if another
/// send is in flight at the same moment - which is the nonce collision the lock
/// prevents, observed directly rather than inferred from a result.
function overlapProbe() {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  return {
    send: (label: string, ms = 5) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start ${label}`);
      await sleep(ms);
      order.push(`end ${label}`);
      inFlight--;
      return label;
    },
    get maxInFlight() { return maxInFlight; },
    order,
  };
}

describe('TreasuryLock', () => {
  it('never lets two sends be in flight at once', async () => {
    const lock = new TreasuryLock();
    const p = overlapProbe();
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((l) => lock.run(p.send(l))));
    expect(p.maxInFlight).toBe(1);
  });

  // FIFO, not merely exclusive: a request that arrives first is sent first.
  it('runs sends in the order they arrived', async () => {
    const lock = new TreasuryLock();
    const p = overlapProbe();
    await Promise.all(['a', 'b', 'c'].map((l) => lock.run(p.send(l))));
    expect(p.order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('releases after a send throws, so one failure does not jam the queue', async () => {
    const lock = new TreasuryLock();
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await lock.run(async () => 'next')).toBe('next');
  });

  it('answers treasury_busy when the wait exceeds its limit', async () => {
    const lock = new TreasuryLock(20);
    const slow = lock.run(() => sleep(80).then(() => 'slow'));
    const waiter = lock.run(async () => 'never');
    const err = await waiter.catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('treasury_busy');
    expect(await slow).toBe('slow');
  });

  // THE SUBTLE ONE. A waiter that times out must hand its place on only once
  // the send AHEAD of it finishes. If it simply left, the caller behind it would
  // start while that send was still in flight - the overlap the lock exists to
  // prevent, reintroduced by the timeout path.
  it('a waiter that times out does not let the next one start early', async () => {
    // Timings chosen so ONLY the property under test decides the outcome. The
    // limit is per lock, so every waiter here has 40ms:
    //   first   0ms, holds the lock for 120ms
    //   quitter 0ms, times out at 40ms while `first` is still running
    //   after   100ms, queued behind quitter's place, waits 20ms - under its
    //           own 40ms limit, so it does run
    // If quitter left the queue at once, `after` would find the way clear at
    // 100ms and start while `first` is still in flight until 120ms. Handing the
    // place on only once `first` finishes is what keeps them apart.
    const lock = new TreasuryLock(40);
    const p = overlapProbe();
    const first = lock.run(p.send('first', 120));
    const quitter = lock.run(p.send('quitter'));
    await expect(quitter).rejects.toMatchObject({ code: 'treasury_busy' });
    await sleep(100 - 40);
    const after = lock.run(p.send('after'));
    await Promise.all([first, after]);
    expect(p.order).not.toContain('start quitter');
    expect(p.maxInFlight).toBe(1);
    expect(p.order.indexOf('start after')).toBeGreaterThan(p.order.indexOf('end first'));
  });
});

// EVERY TREASURY SEND GOES THROUGH THE LOCK - asserted over the source, because
// the claim is about the SET of send sites, and a behavioural test sees only the
// sites it calls. The wallet client is private to Chain, so the type checker
// already forbids reaching it from another file; what the checker allows is a
// second method INSIDE Chain that sends without the lock, and that is what this
// catches. Comments are blanked first, so prose naming the client cannot pass it.
describe('the treasury wallet client is reachable only through sendAsTreasury', () => {
  const SRC = new URL('../src/', import.meta.url);
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

  it('no file but chain.ts names it', () => {
    const named = files.filter(
      (f) => f !== 'chain.ts' && /\bwalletClient\b/.test(blankComments(readFileSync(new URL(f, SRC), 'utf8'))),
    );
    expect(named).toEqual([]);
  });

  it('inside chain.ts it is declared, assigned, and handed out by sendAsTreasury - nothing else', () => {
    const src = blankComments(readFileSync(new URL('chain.ts', SRC), 'utf8'));
    const uses = src.split('\n').filter((l) => /\bwalletClient\b/.test(l)).map((l) => l.trim());
    expect(uses).toEqual([
      'private readonly walletClient: WalletClient;',
      'this.walletClient = createWalletClient({ account, chain: this.viemChain, transport, pollingInterval });',
      'return this.treasuryLock.run(() => fn(this.walletClient));',
    ]);
  });
});
