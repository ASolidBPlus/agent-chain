// Boot without a deployment, and activation.
//
// What these pin: before activation the server answers, authenticates, and
// refuses every route that could move money; a failed activation changes
// nothing the server reads; and once activated, /health is exactly what it
// always was, so a stack that deploys with the boot container sees no change.
import { describe, it, expect, afterEach } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../src/store.ts';
import { ROUTES, DEPLOY_ROUTE, ServicesHolder, createChainSvcServer, type Services } from '../src/server.ts';
import { activate } from '../src/activate.ts';
import { hashToken } from '../src/auth.ts';
import type { Chain, Deployment } from '../src/chain.ts';

const TOKEN = 'platform-token-for-tests';
const TREASURY = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RECORD: Deployment = {
  schema: 1,
  chainId: 31337,
  treasury: TREASURY,
  modules: [{ kind: 'token', key: 'play', contract: 'Token', address: '0x30C43a6d1b31Eb2eB3cAC94b8B8E739f0537bE04' }],
} as unknown as Deployment;

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

function bootHolder(chainOverrides: Record<string, unknown> = {}) {
  const store = new Store(':memory:');
  const chain = {
    treasury: TREASURY,
    publicClient: {
      getChainId: async () => 31337,
      readContract: async () => { throw new Error('symbol() returned no data ("0x")'); },
      getCode: async () => '0x',
    },
    ...chainOverrides,
  } as unknown as Chain;
  const holder = new ServicesHolder({
    config: { token: TOKEN } as never,
    chain,
    store,
    keystore: {} as never,
  });
  return { holder, store, chain };
}

async function serve(holder: ServicesHolder): Promise<string> {
  server = createChainSvcServer(holder);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const platform = { authorization: `Bearer ${TOKEN}` };

describe('a service with no deployment yet', () => {
  it('answers /health, and says it is not deployed', async () => {
    const url = await serve(bootHolder().holder);
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deployed: false });
  });

  it('refuses a money route with not_deployed', async () => {
    const url = await serve(bootHolder().holder);
    const res = await fetch(`${url}/supply`, { headers: platform });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBe('not_deployed');
  });

  // Authentication runs first in both states. A 503 to an unauthenticated
  // caller would tell it something about the deployment it has no right to.
  it('still answers an unauthenticated caller with 401, not 503', async () => {
    const url = await serve(bootHolder().holder);
    const res = await fetch(`${url}/supply`);
    expect(res.status).toBe(401);
  });

  // THE GATE'S ALLOWLIST, PINNED. Every route but the deploy is refused before
  // activation, measured over the whole route table rather than a sample, so a
  // route added later is refused by default and cannot slip past unnoticed.
  //
  // EACH REQUEST IS BUILT TO REACH THE GATE, or it says nothing about the gate.
  // The first version sent a platform token everywhere and `${path}x` as every
  // prefix path: wallet-scope routes were then refused on scope, and suffixed
  // routes never matched, so both stopped BEFORE the gate - five routes "passed"
  // for reasons that had nothing to do with it. Each now gets its real path
  // shape and the credential its scope requires.
  it('refuses every route in the table except the deploy', async () => {
    const { holder, store } = bootHolder();
    store.setWalletTokenHash('orch:w', hashToken('wallet-token-for-tests'));
    const wallet = { authorization: 'Bearer wallet-token-for-tests' };
    const url = await serve(holder);
    const passed: string[] = [];
    let reached = 0;
    for (const r of ROUTES) {
      const isDeploy = r.method === DEPLOY_ROUTE.method && r.path === DEPLOY_ROUTE.path;
      const path = r.prefix ? `${r.path}orch%3Aw${r.suffix ?? ''}` : r.path;
      const res = await fetch(`${url}${path}`, {
        method: r.method,
        headers: { ...(r.scope === 'wallet' ? wallet : platform), 'content-type': 'application/json' },
        body: r.method === 'GET' || r.method === 'DELETE' ? undefined : '{}',
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (body.error === 'not_deployed') reached++;
      if (!isDeploy && body.error !== 'not_deployed') passed.push(`${r.method} ${r.path} -> ${res.status} ${body.error}`);
    }
    expect(passed).toEqual([]);
    // COMPARE TO A VALUE. An empty `passed` would also be what a table of zero
    // routes produces; this says the gate was actually reached, by all of them.
    expect(reached).toBe(ROUTES.filter((r) => !(r.method === DEPLOY_ROUTE.method && r.path === DEPLOY_ROUTE.path)).length);
    expect(reached).toBeGreaterThan(20);
  });
});

describe('a failed activation', () => {
  // NOTHING IS SWAPPED UNTIL EVERY CHECK HAS PASSED, and no event tail runs.
  // Each row fails a different early step; in every one the server must be
  // left exactly as it was.
  const cases: [string, Record<string, unknown>][] = [
    ['(a) the wrong mnemonic for the record', { treasury: '0x000000000000000000000000000000000000dEaD' }],
    ['(b) a chain the record was not made on', {
      publicClient: { getChainId: async () => 1, readContract: async () => 0, getCode: async () => '0x' },
    }],
    ['(c) a token whose code is not there', {}],
  ];
  for (const [label, overrides] of cases) {
    it(`${label} leaves nothing swapped and no event tail`, async () => {
      const { holder, chain } = bootHolder(overrides);
      await expect(activate(holder, RECORD)).rejects.toThrow();
      expect(holder.current).toBeNull();
      expect(holder.events).toBeNull();
      expect((chain as { modules?: unknown }).modules).toBeUndefined();
      expect((chain as { deployment?: unknown }).deployment).toBeUndefined();
    });
  }
});

describe('once activated', () => {
  // EXACTLY THE BODY IT ALWAYS HAD, so a container-mode stack sees no change.
  it('/health lists the modules, as before', async () => {
    const { holder, chain } = bootHolder();
    (chain as { modules: unknown }).modules = {
      tokens: [{ key: 'play', address: '0x1', symbol: 'PLAY', decimals: 18 }],
      names: { address: '0x2', tld: 'play' },
    };
    holder.swap({ chain } as unknown as Services);
    const url = await serve(holder);
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true, modules: ['names', 'token:play'] });
  });
});
