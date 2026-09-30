// POST /admin/deploy, against a fake chain.
//
// What these pin is the ORDER: every refusal that needs no transaction comes
// before the first one, and no record exists until the deployment has passed
// its assertions. What only a real chain can show - that the addresses, code
// and roles equal the container's, and that a repeat sends nothing - is
// scripts/verify-admin-deploy.ts, run by the contracts workflow against anvil.
import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { keccak256, toBytes, type Hex } from 'viem';
import { Store } from '../src/store.ts';
import { ServicesHolder, createChainSvcServer } from '../src/server.ts';
import { hashToken } from '../src/auth.ts';
import type { Chain } from '../src/chain.ts';
import { treasurySender } from './support/treasury.ts';
import { adminDeploy } from '../src/admin-deploy.ts';
import { HttpError } from '../src/errors.ts';

const TOKEN = 'platform-token-for-tests';
const TREASURY = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TOKEN_ONLY = JSON.stringify({
  schema: 1,
  modules: [{ kind: 'token', key: 'play', name: 'Play Token', symbol: 'PLAY', initialSupply: '1000000' }],
});
const role = (name: string) => keccak256(toBytes(name));

let server: Server | null = null;
const dirs: string[] = [];
afterEach(() => {
  server?.close();
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FakeOptions {
  /// What getCode answers at every address.
  code?: Hex;
  /// Roles the fake says nobody holds - how an assertion is made to fail.
  withheld?: string[];
}

/// A chain that records what is sent and answers reads from a few rules. Enough
/// for the route to plan, send and assert; not enough to activate, which is
/// what the real-chain script is for.
function fakeChain(opts: FakeOptions = {}) {
  const sent: string[] = [];
  const reads: string[] = [];
  let minted = 0n;
  const wallet = {
    account: { address: TREASURY },
    sendTransaction: async ({ to }: { to: string }) => {
      sent.push(`create ${to}`);
      return `0x${'1'.repeat(64)}` as Hex;
    },
    writeContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      sent.push(functionName);
      if (functionName === 'mint') minted += args[1] as bigint;
      return `0x${'2'.repeat(64)}` as Hex;
    },
  };
  const withheld = new Set((opts.withheld ?? []).map(role));
  const chain = {
    treasury: TREASURY,
    ...treasurySender(wallet),
    publicClient: {
      getChainId: async () => 31337,
      getCode: async () => {
        reads.push('getCode');
        return opts.code ?? '0x';
      },
      waitForTransactionReceipt: async () => ({ status: 'success' }),
      readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        reads.push(functionName);
        if (functionName === 'totalSupply' || functionName === 'balanceOf') return minted;
        if (functionName === 'hasRole') {
          const [r, who] = args as [Hex, string];
          return who.toLowerCase() === TREASURY.toLowerCase() && !withheld.has(r) && r !== role('BURNER_ROLE');
        }
        if (functionName === 'DEFAULT_ADMIN_ROLE') return `0x${'0'.repeat(64)}`;
        if (functionName.endsWith('_ROLE')) return role(functionName);
        throw new Error(`the fake chain does not answer ${functionName}`);
      },
    },
  } as unknown as Chain;
  return { chain, sent, reads };
}

function boot(chain: Chain, config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-deploy-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'deployment'));
  const store = new Store(':memory:');
  const holder = new ServicesHolder({
    config: { token: TOKEN, deployMode: 'admin', storePath: join(dir, 'chain-svc.sqlite'), ...config } as never,
    chain,
    store,
    keystore: {} as never,
  });
  return { holder, store, dir, recordPath: join(dir, 'deployment', 'local.json'), manifestPath: join(dir, 'deployment', 'manifest.json') };
}

async function deploy(holder: ServicesHolder, body: string, authorization = `Bearer ${TOKEN}`) {
  if (!server) {
    server = createChainSvcServer(holder);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  }
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${url}/admin/deploy`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body });
  return { status: res.status, body: (await res.json()) as { error?: string; detail?: string } };
}

describe('POST /admin/deploy refuses before the first transaction', () => {
  it('in container mode, with 409 and nothing sent or read', async () => {
    const f = fakeChain();
    const { holder } = boot(f.chain, { deployMode: 'container' });
    const res = await deploy(holder, TOKEN_ONLY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('deployment_conflict');
    expect(res.body.detail).toContain('DEPLOY_MODE=container');
    expect(f.sent).toEqual([]);
    expect(f.reads).toEqual([]);
  });

  it('to a wallet credential', async () => {
    const f = fakeChain();
    const { holder, store } = boot(f.chain);
    store.setWalletTokenHash('orch:w', hashToken('wallet-token-for-tests'));
    const res = await deploy(holder, TOKEN_ONLY, 'Bearer wallet-token-for-tests');
    expect(res.status).toBe(403);
    expect(f.sent).toEqual([]);
  });

  // The handler's own check, isolated: the router refuses a wallet credential
  // first, so the test above passes with either check alone.
  it('to a wallet principal, in the handler itself', () => {
    const f = fakeChain();
    const { holder } = boot(f.chain);
    let code = 'no-error';
    try {
      void adminDeploy(holder, { scope: 'wallet', agentId: 'orch:w' }, TOKEN_ONLY);
    } catch (err) {
      code = err instanceof HttpError ? err.code : String(err);
    }
    expect(code).toBe('wrong_scope');
    expect(f.reads).toEqual([]);
  });

  it('for a manifest the grammar refuses, without reading the chain', async () => {
    const f = fakeChain();
    const { holder } = boot(f.chain);
    const res = await deploy(holder, JSON.stringify({ schema: 1, modules: [] }));
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('at least one module');
    expect(f.reads).toEqual([]);
  });

  // (ii) The would-be record goes through the rules every record goes through.
  it('for a key the record rules reserve', async () => {
    const f = fakeChain();
    const { holder } = boot(f.chain);
    const body = JSON.stringify({ schema: 1, modules: [{ kind: 'token', key: 'stage', name: 'N', symbol: 'N', initialSupply: '1' }] });
    const res = await deploy(holder, body);
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('is a column name');
    expect(f.sent).toEqual([]);
  });

  // (iii) The check activation would otherwise make after the contracts exist.
  it('for policy defaults it cannot load', async () => {
    const f = fakeChain();
    const { holder, dir } = boot(f.chain, {});
    const path = join(dir, 'policy.json');
    writeFileSync(path, JSON.stringify({ org: {} }));
    holder.boot.config.policyDefaultsPath = path;
    const res = await deploy(holder, TOKEN_ONLY);
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('policy defaults at');
    expect(f.sent).toEqual([]);
  });

  // (iv) A store that belongs to another deployment.
  it('for a store written against another deployment', async () => {
    const f = fakeChain();
    const { holder, store } = boot(f.chain);
    // NOT the address this manifest derives (0x30C4...bE04): a store recorded
    // against that one is this deployment, and the first draft of this test
    // used it and watched the route go on to deploy.
    store.recordDeployment({ chainId: '31337', modules: [{ kind: 'token', key: 'play', address: '0x000000000000000000000000000000000000dEaD' }] });
    const res = await deploy(holder, TOKEN_ONLY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('deployment_conflict');
    expect(f.sent).toEqual([]);
  });

  // (v) Once a record exists, only the manifest that made it.
  describe('once a record exists', () => {
    const recorded = (text: string) => {
      const f = fakeChain({ withheld: ['FREEZER_ROLE'] });
      const b = boot(f.chain);
      writeFileSync(b.recordPath, '{}');
      writeFileSync(b.manifestPath, text);
      return { ...b, f };
    };

    it('for another manifest', async () => {
      const { holder, f } = recorded(TOKEN_ONLY);
      const res = await deploy(holder, TOKEN_ONLY.replace('1000000', '1000001'));
      expect(res.status).toBe(409);
      expect(res.body.detail).toContain('another manifest');
      expect(f.sent).toEqual([]);
    });

    // JSON.parse reads these two as one number (MEASURED); a comparison made
    // after it would call a changed supply the same manifest.
    it('for a supply that differs only past 2^53', async () => {
      const at = (n: string) => `{"schema":1,"modules":[{"kind":"token","key":"play","name":"P","symbol":"P","initialSupply":${n}}]}`;
      const { holder, f } = recorded(at('9007199254740992'));
      const res = await deploy(holder, at('9007199254740993'));
      expect(res.status).toBe(409);
      expect(f.sent).toEqual([]);
    });

    it('when nothing says which manifest made it', async () => {
      const { holder, f, manifestPath } = recorded(TOKEN_ONLY);
      rmSync(manifestPath);
      const res = await deploy(holder, TOKEN_ONLY);
      expect(res.status).toBe(409);
      expect(res.body.detail).toContain('no manifest.json');
      expect(f.sent).toEqual([]);
    });

    // The positive control for the three above: the same document, with its
    // keys in another order, is past the comparison and reaches the chain.
    it('but not for the same manifest with its keys reordered', async () => {
      const { holder, f } = recorded(TOKEN_ONLY);
      const reordered = JSON.stringify({ modules: JSON.parse(TOKEN_ONLY).modules, schema: 1 });
      const res = await deploy(holder, reordered);
      expect(res.body.detail).toBe('treasury lacks FREEZER_ROLE');
    });
  });

  it('for foreign code at a module address, naming it', async () => {
    const f = fakeChain({ code: '0x6000' });
    const { holder, recordPath } = boot(f.chain);
    const res = await deploy(holder, TOKEN_ONLY);
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('holds code that is not Token');
    expect(f.sent).toEqual([]);
    expect(existsSync(recordPath)).toBe(false);
  });
});

describe('POST /admin/deploy writes no record', () => {
  it('when a post-deploy assertion fails, and names the assertion', async () => {
    const f = fakeChain({ withheld: ['FREEZER_ROLE'] });
    const { holder, recordPath, manifestPath } = boot(f.chain);
    const res = await deploy(holder, TOKEN_ONLY);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('deployment_failed');
    expect(res.body.detail).toBe('treasury lacks FREEZER_ROLE');
    // It did send - the assertion is about what the sends produced.
    expect(f.sent).toEqual([expect.stringMatching(/^create 0x/i), 'mint']);
    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
    expect(holder.current).toBeNull();
  });
});

describe('POST /admin/deploy runs one deploy at a time', () => {
  it('holds a second call until the first has finished', async () => {
    let inFlight = 0;
    let most = 0;
    const f = fakeChain({ withheld: ['FREEZER_ROLE'] });
    const getCode = f.chain.publicClient.getCode.bind(f.chain.publicClient);
    (f.chain.publicClient as unknown as { getCode: unknown }).getCode = async (a: never) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return getCode(a);
    };
    const { holder } = boot(f.chain);
    const [a, b] = await Promise.all([deploy(holder, TOKEN_ONLY), deploy(holder, TOKEN_ONLY)]);
    expect([a.status, b.status]).toEqual([500, 500]);
    expect(f.reads.filter((r) => r === 'getCode').length).toBe(2);
    expect(most).toBe(1);
  });

  // The queue must not be poisoned by a failure: the call after a failed one
  // still runs (the fake fails it again, at the same assertion).
  it('and a failure does not stop the next', async () => {
    const f = fakeChain({ withheld: ['FREEZER_ROLE'] });
    const { holder } = boot(f.chain);
    expect((await deploy(holder, '{')).status).toBe(400);
    expect((await deploy(holder, TOKEN_ONLY)).body.detail).toBe('treasury lacks FREEZER_ROLE');
  });
});
