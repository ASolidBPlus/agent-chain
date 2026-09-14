import { describe, it, expect } from 'bun:test';
import { Store, MAX_BUFFERED_EVENTS } from '../src/store.ts';

describe('memos', () => {
  it('joins a memo back onto its transaction, case-insensitively', () => {
    const store = new Store(':memory:');
    store.recordMemo({ txHash: '0xABC', memo: 'for the stream job', intentId: 'a1', fromAgentId: 'orch:vendor' });

    const found = store.memosFor(['0xabc']);
    expect(found.get('0xabc')?.memo).toBe('for the stream job');
    expect(found.get('0xabc')?.intentId).toBe('a1');
    store.close();
  });

  it('returns nothing for unknown hashes rather than throwing', () => {
    const store = new Store(':memory:');
    expect(store.memosFor(['0xdeadbeef']).size).toBe(0);
    expect(store.memosFor([]).size).toBe(0);
    store.close();
  });
});

describe('frozen', () => {
  // This table is the ONLY truth for whether a wallet may spend; the per-agent
  // POLICY_FILE is a fast-path copy that loses any disagreement.
  it('records and reports a freeze, and is idempotent', () => {
    const store = new Store(':memory:');
    expect(store.isFrozen('orch:scammer')).toBe(false);

    store.freeze('orch:scammer');
    expect(store.isFrozen('orch:scammer')).toBe(true);

    store.freeze('orch:scammer');
    expect(store.isFrozen('orch:scammer')).toBe(true);
    expect(store.isFrozen('orch:vendor')).toBe(false);
    store.close();
  });
});

describe('the event outbox', () => {
  it('buffers events until they are delivered', () => {
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { txHash: '0x1' });
    store.enqueueEvent('agent.spend', { intent_id: 'a1' });
    expect(store.pendingEventCount()).toBe(2);

    const due = store.dueEvents(10);
    expect(due).toHaveLength(2);
    expect(JSON.parse(due[0]!.payload)).toEqual({ txHash: '0x1' });

    store.eventDelivered(due[0]!.id);
    expect(store.pendingEventCount()).toBe(1);
    store.close();
  });

  it('backs off a failed event instead of retrying it immediately', () => {
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { txHash: '0x1' });
    const [event] = store.dueEvents(10);

    const now = Date.now();
    store.eventFailed(event!.id, now);

    expect(store.dueEvents(10, now)).toHaveLength(0);
    expect(store.dueEvents(10, now + 10 * 60_000)).toHaveLength(1);
    store.close();
  });

  // A hub-core that is down - or absent, which it is until C5 - must not be
  // able to fill the disk. Oldest go first and the drop count is returned so
  // the caller can log it: a silently truncated audit trail is worse than a
  // noisy one.
  it('bounds the buffer and reports what it dropped', () => {
    const store = new Store(':memory:');
    let dropped = 0;
    for (let i = 0; i < MAX_BUFFERED_EVENTS + 5; i++) {
      dropped += store.enqueueEvent('chain.transfer', { i });
    }

    expect(dropped).toBe(5);
    expect(store.pendingEventCount()).toBe(MAX_BUFFERED_EVENTS);

    // The five dropped are the OLDEST, so the survivors start at i=5.
    const [oldest] = store.dueEvents(1);
    expect(JSON.parse(oldest!.payload)).toEqual({ i: 5 });
    store.close();
  }, 30_000);
});
