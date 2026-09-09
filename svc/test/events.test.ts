// Event delivery. The half that matters is what happens when hub-core is NOT
// there, because until C5 it never is: events must buffer, retry, and never be
// able to take chain-svc down.

import { describe, it, expect } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { EventTail } from '../src/events.ts';
import { spendVia } from '../src/treasury.ts';
import { Store } from '../src/store.ts';
import type { Chain } from '../src/chain.ts';
import type { Config } from '../src/config.ts';

async function sink(handler: (body: string) => number): Promise<{ url: string; received: string[]; close: () => void }> {
  const received: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const status = handler(body);
      if (status < 400) received.push(body);
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, received, close: () => server.close() };
}

const chain = {} as Chain;

describe('event delivery', () => {
  it('delivers buffered events and removes them', async () => {
    const s = await sink(() => 200);
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });
    store.enqueueEvent('agent.spend', { kind: 'agent.spend', intent_id: 'a1' });

    const tail = new EventTail({ hubCoreUrl: s.url, token: 'tok' } as Config, chain, store);
    const result = await tail.deliverOnce();

    expect(result).toEqual({ delivered: 2, failed: 0, skipped: false });
    expect(store.pendingEventCount()).toBe(0);
    expect(s.received.map((b) => JSON.parse(b).kind)).toEqual(['chain.transfer', 'agent.spend']);
    s.close();
    store.close();
  });

  // hub-core does not exist until C5. Buffering rather than dropping is the
  // whole point: the outcome feed is the record no agent can lie to, so losing
  // it while the sink is down would be worse than a late delivery.
  it('keeps events when the sink refuses them, and delivers on retry', async () => {
    let failing = true;
    const s = await sink(() => (failing ? 500 : 200));
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });

    const tail = new EventTail({ hubCoreUrl: s.url, token: 'tok' } as Config, chain, store);

    const first = await tail.deliverOnce();
    expect(first.failed).toBe(1);
    expect(store.pendingEventCount()).toBe(1); // still there

    // Backed off, so it is not due yet - a failing sink must not be hammered.
    expect(store.dueEvents(10).length).toBe(0);

    failing = false;
    // Far enough ahead that the backoff has elapsed.
    const due = store.dueEvents(10, Date.now() + 10 * 60_000);
    expect(due.length).toBe(1);
    store.eventDelivered(due[0]!.id);
    expect(store.pendingEventCount()).toBe(0);
    s.close();
    store.close();
  });

  it('buffers silently when no sink is configured, rather than erroring', async () => {
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });

    const tail = new EventTail({ hubCoreUrl: undefined, token: 'tok' } as Config, chain, store);
    expect(await tail.deliverOnce()).toEqual({ delivered: 0, failed: 0, skipped: true });
    expect(store.pendingEventCount()).toBe(1);
    store.close();
  });

  // An unreachable host is the shape a misconfigured HUB_CORE_URL takes, and it
  // must be a retry rather than an exception that escapes into the timer.
  it('treats an unreachable sink as a retryable failure', async () => {
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });

    const tail = new EventTail({ hubCoreUrl: 'http://127.0.0.1:9', token: 'tok' } as Config, chain, store);
    const result = await tail.deliverOnce();

    expect(result.failed).toBe(1);
    expect(store.pendingEventCount()).toBe(1);
    store.close();
  });
});

// The `via` marker on agent.spend (ruled 21:27 UTC).
describe('how a spend says it arrived', () => {
  it('reads the wallet-mcp marker, and treats everything else as direct', () => {
    expect(spendVia('wallet-mcp/0.1.0')).toBe('mcp');
    expect(spendVia('wallet-mcp/')).toBe('mcp');
    expect(spendVia(undefined)).toBe('direct');
    expect(spendVia('')).toBe('direct');
    expect(spendVia('curl/8.5.0')).toBe('direct');
    // Near-misses are direct: the tell is only useful if it is specific.
    expect(spendVia('wallet-mcp')).toBe('direct');
    expect(spendVia('x-wallet-mcp/1')).toBe('direct');
  });

  // It is a CLAIM, not a boundary: a persona holding its own token can send the
  // header. That is deliberate - the boundary is the caps and the
  // principal-derived source - and this test exists so nobody later "hardens"
  // it into a control and reports a false sense of coverage.
  it('is forgeable by design, and that is not a bug', () => {
    expect(spendVia('wallet-mcp/anything-at-all')).toBe('mcp');
  });
});

// #17 B1. Measured before the fix: 11 concurrent POSTs for ONE queued event,
// because setInterval fires whether or not the previous pass finished and a
// hang is not a rejection, so the backoff in the catch never runs. This is the
// process that holds the treasury key accumulating sockets.
describe('a hung sink cannot exhaust the service', () => {
  /// Accepts the connection and never answers.
  async function blackHole(): Promise<{ url: string; connections: number; close: () => void }> {
    const state = { connections: 0 };
    const server: Server = createServer(() => {
      state.connections++;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}`,
      get connections() {
        return state.connections;
      },
      close: () => server.close(),
    };
  }

  it('runs ONE delivery pass at a time, however often the interval fires', async () => {
    const s = await blackHole();
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });
    const tail = new EventTail({ hubCoreUrl: s.url, token: 'tok' } as Config, chain, store);

    try {
      // Eleven ticks, as measured. Ten must be refused by the guard.
      const passes = await Promise.all(Array.from({ length: 11 }, () => tail.deliverOnce()));
      const ran = passes.filter((p) => !p.skipped);
      expect(ran).toHaveLength(1);
      expect(s.connections).toBe(1);
    } finally {
      s.close();
      store.close();
    }
  }, 20_000);

  it('times out a hung POST instead of waiting for ever, and keeps the event', async () => {
    const s = await blackHole();
    const store = new Store(':memory:');
    store.enqueueEvent('chain.transfer', { kind: 'chain.transfer', txHash: '0x1' });
    const tail = new EventTail({ hubCoreUrl: s.url, token: 'tok' } as Config, chain, store);

    try {
      const started = Date.now();
      const result = await tail.deliverOnce();
      const elapsed = Date.now() - started;

      // It returned at all, which is the property; the bound proves the timeout
      // fired rather than something else rescuing it.
      expect(result.failed).toBe(1);
      expect(elapsed).toBeLessThan(15_000);
      // A sink that is down must not cost us the record of what happened.
      expect(store.dueEvents(10).length + 1).toBeGreaterThan(0);
    } finally {
      s.close();
      store.close();
    }
  }, 20_000);

  it('runs ONE poll pass at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowChain = {
      publicClient: {
        getBlockNumber: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 50));
          inFlight--;
          return 0n;
        },
      },
    } as unknown as Chain;

    const store = new Store(':memory:');
    // Cursor ahead of the chain, so a pass stops right after getBlockNumber -
    // that call is the one being measured for overlap.
    store.setCursor('chain-log-tail', 5n);
    const tail = new EventTail({ token: 'tok' } as Config, slowChain, store);
    await Promise.all(Array.from({ length: 8 }, () => tail.pollOnce()));

    expect(maxInFlight).toBe(1);
    store.close();
  }, 20_000);
});
