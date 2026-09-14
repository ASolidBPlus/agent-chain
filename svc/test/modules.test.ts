// §8.4. THE ROUTE GATE, through a real listening server rather than by calling
// `assertModulesDeployed` directly.
//
// The gate is one line in `handle()`, and the bug that matters is not "does the
// function refuse?" - it is "does a request actually reach it, and in the right
// order relative to authentication?". A unit test of the predicate cannot tell
// the difference between a gate that runs and a gate that is never called.
//
// Each deployment shape gets its own server, because the module view is built
// once at boot and read from `chain.modules` on every request: that is what the
// real service does, and a test that mutated it between requests would be
// exercising a lifecycle nothing has.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'node:http';
import { createChainSvcServer, type Services } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { hashToken } from '../src/auth.ts';

const TOKEN = 'platform-credential';
const WALLET_TOKEN = 'wallet-credential';
const AGENT = 'orch:a';
const ADDRESS = '0x1111111111111111111111111111111111111111';

const TOKEN_MODULE = { key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 };
const NAMES_MODULE = { address: '0xreg', tld: 'play' };

interface Harness {
  server: Server;
  base: string;
  store: Store;
}

async function serve(modules: Record<string, unknown>): Promise<Harness> {
  const store = new Store(':memory:');
  store.setWalletTokenHash(AGENT, hashToken(WALLET_TOKEN));
  store.markSpawned(AGENT, ADDRESS, 'agent');

  const services = {
    config: { token: TOKEN },
    store,
    chain: {
      deployment: { chainId: 31337, treasury: '0xtreasury' },
      modules,
      // Any handler that gets past the gate on these shapes would need a chain;
      // none of the assertions below should, and this makes that a failure
      // rather than a silent pass against a mock.
      publicClient: {
        readContract: () => {
          throw new Error('the chain must not be reached in a gating test');
        },
      },
    },
    resolver: {
      lookup: async () => null,
      require: async () => {
        throw new Error('the resolver must not be reached in a gating test');
      },
      reverseOf: async () => null,
      aliasesOf: async () => [],
    },
  } as unknown as Services;

  const server = createChainSvcServer(services);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, store };
}

const platform = { authorization: `Bearer ${TOKEN}` };
const wallet = { authorization: `Bearer ${WALLET_TOKEN}` };

async function code(h: Harness, method: string, path: string, headers = platform): Promise<string> {
  const res = await fetch(`${h.base}${path}`, { method, headers });
  if (res.status === 200) return 'ok';
  return ((await res.json()) as { error: string }).error;
}

describe('a names-only deployment', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await serve({ tokens: [], names: NAMES_MODULE });
  });
  afterAll(() => {
    h.server.close();
    h.store.close();
  });

  it('refuses every money route with module_not_deployed', async () => {
    expect(await code(h, 'GET', '/supply')).toBe('module_not_deployed');
    expect(await code(h, 'GET', '/balance/orch%3Aa', wallet)).toBe('module_not_deployed');
    expect(await code(h, 'POST', '/fund')).toBe('module_not_deployed');
    expect(await code(h, 'POST', '/sign-transfer', wallet)).toBe('module_not_deployed');
  });

  it('serves the name routes', async () => {
    // 404 from the HANDLER, not from the gate: the route is open on this
    // deployment and the name is simply not registered. Distinguishing those
    // two answers is the whole point of the assertion - a gate that refused
    // here would look identical to a working deployment with no such name.
    //
    // Asked with the wallet credential so it takes the bare-id path through
    // `lookup`, leaving `require` as a tripwire for the tests that must not
    // reach the resolver at all.
    expect(await code(h, 'GET', '/resolve/nothing', wallet)).toBe('unknown_name');
  });

  it('lists only the deployed module on /health and /modules', async () => {
    expect(await (await fetch(`${h.base}/health`)).json()).toEqual({ ok: true, modules: ['names'] });
    const m = (await (await fetch(`${h.base}/modules`, { headers: platform })).json()) as Record<string, unknown>;
    expect(m.defaultToken).toBeNull();
    expect(m.tokens).toEqual([]);
    expect(m.names).toEqual({ address: '0xreg', tld: 'play' });
  });
});

describe('a token-only deployment', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await serve({ tokens: [TOKEN_MODULE] });
  });
  afterAll(() => {
    h.server.close();
    h.store.close();
  });

  it('refuses every name route with module_not_deployed', async () => {
    expect(await code(h, 'GET', '/resolve/anything')).toBe('module_not_deployed');
    expect(await code(h, 'GET', '/reverse/0xabc')).toBe('module_not_deployed');
    expect(await code(h, 'POST', '/aliases')).toBe('module_not_deployed');
  });

  it('lists only the deployed module', async () => {
    expect(await (await fetch(`${h.base}/health`)).json()).toEqual({ ok: true, modules: ['token:play'] });
    const m = (await (await fetch(`${h.base}/modules`, { headers: platform })).json()) as Record<string, unknown>;
    expect(m.defaultToken).toBe('play');
    expect(m.names).toBeNull();
  });
});

describe('a two-token deployment', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await serve({
      tokens: [TOKEN_MODULE, { key: 'gold', address: '0xgold', symbol: 'GOLD', decimals: 18 }],
      names: NAMES_MODULE,
    });
  });
  afterAll(() => {
    h.server.close();
    h.store.close();
  });

  it('names the FIRST token as the default and lists both', async () => {
    const m = (await (await fetch(`${h.base}/modules`, { headers: platform })).json()) as {
      defaultToken: string;
      tokens: Array<{ key: string }>;
    };
    expect(m.defaultToken).toBe('play');
    expect(m.tokens.map((t) => t.key)).toEqual(['play', 'gold']);
  });

  it('sorts /health so two deployments with the same modules compare equal', async () => {
    expect(await (await fetch(`${h.base}/health`)).json()).toEqual({
      ok: true,
      modules: ['names', 'token:gold', 'token:play'],
    });
  });
});

// THE ORDER OF THE TWO CHECKS, which is the half of this that is a security
// property rather than a usability one.
describe('the gate does not run before authentication', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await serve({ tokens: [], names: NAMES_MODULE });
  });
  afterAll(() => {
    h.server.close();
    h.store.close();
  });

  it('answers an unauthenticated caller with unauthorized, not module_not_deployed', async () => {
    // /fund needs a token this deployment does not have, so a gate running
    // first would answer module_not_deployed - and a stranger could map which
    // modules a deployment has by reading which refusal each path returns.
    const res = await fetch(`${h.base}/fund`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
  });

  it('answers a wrong-scope caller with wrong_scope, not module_not_deployed', async () => {
    const res = await fetch(`${h.base}/fund`, { method: 'POST', headers: wallet });
    expect(((await res.json()) as { error: string }).error).toBe('wrong_scope');
  });
});
