// The "play money is structural, not configured" guards (spec S4, ruled
// UTC). These are the tests that stop the property from quietly becoming false
// the day someone repoints RPC_URL, so they assert on PROCESS EXIT, not on a
// function return: the guarantee is "chain-svc cannot run", not "a helper
// returns false".

import { describe, it, expect } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrivateRpcUrl } from '../src/chain.ts';
import { hubCoreUrl } from '../src/config.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

// Account 0 of the canonical, publicly-published Foundry test phrase.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const TEST_TREASURY = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function fixture(chainId: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'chain-svc-'));
  mkdirSync(join(dir, 'deployments'), { recursive: true });
  writeFileSync(
    join(dir, 'deployments', 'local.json'),
    JSON.stringify({
      schema: 1,
      chainId,
      treasury: TEST_TREASURY,
      modules: [
        {
          kind: 'token',
          key: 'play',
          contract: 'Token',
          address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        },
        {
          kind: 'names',
          contract: 'NameRegistry',
          address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
          tld: 'play',
        },
      ],
    }),
  );
  return dir;
}

async function startService(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts'], {
    cwd: PKG,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // If a guard is ever removed the process will START rather than exit, so cap
  // the wait and kill it: a hung test must not read as a pass.
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [code, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  clearTimeout(timer);
  return { code, stderr: stderr + stdout };
}

function baseEnv(dir: string, rpcUrl: string): Record<string, string> {
  return {
    RPC_URL: rpcUrl,
    CHAIN_SVC_TOKEN: 'test-token',
    KEYSTORE_SECRET: 'test-secret',
    ANVIL_MNEMONIC: TEST_MNEMONIC,
    DEPLOYMENTS_DIR: join(dir, 'deployments'),
    KEYSTORE_DIR: join(dir, 'keystore'),
    POLICY_DIR: join(dir, 'policies'),
    STORE_PATH: join(dir, 'store', 'chain-svc.sqlite'),
    // A real port: these tests exit before listening, but PORT=0 is rejected by
    // config validation and would mask the failure being asserted.
    PORT: '17545',
  };
}

describe('RPC host restriction', () => {
  it('accepts loopback, RFC 1918 and Compose service names', () => {
    for (const url of [
      'http://chain:8545',
      'http://localhost:8545',
      'http://127.0.0.1:8545',
      'http://10.1.2.3:8545',
      'http://172.16.0.1:8545',
      'http://192.168.1.5:8545',
      'http://[::1]:8545',
    ]) {
      expect(() => assertPrivateRpcUrl(url)).not.toThrow();
    }
  });

  it('refuses public hosts and addresses', () => {
    for (const url of [
      'https://mainnet.example',
      'https://eth-mainnet.g.alchemy.com/v2/key',
      'http://8.8.8.8:8545',
      'http://[2001:4860:4860::8888]:8545',
      'not a url',
    ]) {
      expect(() => assertPrivateRpcUrl(url)).toThrow(/refusing_public_rpc/);
    }
  });

  // 172.16-31 is private; 172.15 and 172.32 are not. An off-by-one here would
  // silently widen the allowlist to public space.
  it('gets the 172.16/12 boundaries right', () => {
    expect(() => assertPrivateRpcUrl('http://172.15.0.1:8545')).toThrow(/refusing_public_rpc/);
    expect(() => assertPrivateRpcUrl('http://172.32.0.1:8545')).toThrow(/refusing_public_rpc/);
    expect(() => assertPrivateRpcUrl('http://172.31.255.254:8545')).not.toThrow();
  });
});

describe('the service refuses to start', () => {
  // Spec S4's first named test.
  it('against a public RPC endpoint, exiting non-zero with refusing_public_rpc', async () => {
    const dir = fixture(31337);
    const { code, stderr } = await startService(baseEnv(dir, 'https://mainnet.example'));
    expect(code).not.toBe(0);
    expect(stderr).toContain('refusing_public_rpc');
  }, 30_000);

  // Spec S4's second named test: a private-looking host that answers with a
  // PUBLIC chain id. The host check cannot catch this one - only the chain id
  // can - which is why both guards exist.
  it('against an RPC answering chain id 1, exiting non-zero with wrong_chain_id', async () => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { id } = JSON.parse(body || '{}') as { id?: number };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, result: '0x1' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = fixture(31337);
      const { code, stderr } = await startService(baseEnv(dir, `http://127.0.0.1:${port}`));
      expect(code).not.toBe(0);
      expect(stderr).toContain('wrong_chain_id');
    } finally {
      server.close();
    }
  }, 30_000);

  // The one that actually matters, and the one the test above CANNOT prove.
  //
  // assertPrivateChain has two guards: "the RPC is not on 31337" and "the RPC
  // disagrees with local.json". The test above trips BOTH (fixture says 31337,
  // RPC says 1), so it passes even with the 31337 assertion deleted - verified
  // by mutation, which is how this gap was found.
  //
  // Here the deployment and the RPC AGREE on chain id 1: exactly the shape of
  // someone deploying against a real network and writing a matching local.json.
  // Only the 31337 assertion can catch that, so this test isolates it.
  it('against a deployment that AGREES with a public chain id, which only the 31337 assertion catches', async () => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { id } = JSON.parse(body || '{}') as { id?: number };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, result: '0x1' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = fixture(1);
      const { code, stderr } = await startService(baseEnv(dir, `http://127.0.0.1:${port}`));
      expect(code).not.toBe(0);
      expect(stderr).toContain('wrong_chain_id');
      expect(stderr).toContain('expected 31337');
    } finally {
      server.close();
    }
  }, 30_000);

  // The mirror of the test above, isolating the SECOND guard. Here the RPC is
  // on 31337 (so the "not 31337" assertion is satisfied) but local.json was
  // written for a different chain - a stale deployment file pointing at
  // contracts that do not exist at those addresses on this chain. Found the
  // same way: the first version of these tests could not tell the two guards
  // apart, and deleting either one left the suite green.
  it('against a deployment file written for a different chain, which only the agreement check catches', async () => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { id } = JSON.parse(body || '{}') as { id?: number };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, result: '0x7a69' })); // 31337
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = fixture(1337);
      const { code, stderr } = await startService(baseEnv(dir, `http://127.0.0.1:${port}`));
      expect(code).not.toBe(0);
      expect(stderr).toContain('wrong_chain_id');
      expect(stderr).toContain('local.json');
    } finally {
      server.close();
    }
  }, 30_000);

  it('with a required secret missing, naming the variable', async () => {
    const dir = fixture(31337);
    const env = baseEnv(dir, 'http://chain:8545');
    delete (env as Record<string, string | undefined>).CHAIN_SVC_TOKEN;
    const { code, stderr } = await startService({ ...env, CHAIN_SVC_TOKEN: '' });
    expect(code).not.toBe(0);
    expect(stderr).toContain('CHAIN_SVC_TOKEN');
  }, 30_000);
});

// #17 B3. CHAIN_SVC_TOKEN is both the inbound credential and the outbound
// bearer to HUB_CORE_URL, so whatever answers there is HANDED the token that
// authorises moving the game's money. An unvalidated destination for that
// header is an exfiltration path whose trigger is a config typo.
describe('HUB_CORE_URL is validated as strictly as RPC_URL', () => {
  it('accepts unset and empty as "no hub-core yet"', () => {
    expect(hubCoreUrl(undefined)).toBeUndefined();
    expect(hubCoreUrl('')).toBeUndefined();
    expect(hubCoreUrl('   ')).toBeUndefined();
    }, 30_000);

  it('accepts a private host', () => {
    expect(hubCoreUrl('http://hub-core:8080')).toBe('http://hub-core:8080');
    expect(hubCoreUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(hubCoreUrl('http://10.1.2.3:8080')).toBe('http://10.1.2.3:8080');
    }, 30_000);

  it('refuses a public destination for the token', () => {
    expect(() => hubCoreUrl('https://evil.example.com/collect')).toThrow(/refusing_public_hub_core/);
    expect(() => hubCoreUrl('http://8.8.8.8/')).toThrow(/refusing_public_hub_core/);
    }, 30_000);

  it('refuses junk rather than silently treating it as unset', () => {
    // The failure mode this replaces: a typo became `undefined`, events queued
    // for ever, and nobody found out until someone asked why the timeline was
    // empty.
    expect(() => hubCoreUrl('not-a-url')).toThrow(/not a valid URL/);
    expect(() => hubCoreUrl('ftp://hub-core/')).toThrow(/must be http or https/);
    expect(() => hubCoreUrl('file:///etc/passwd')).toThrow(/must be http or https/);
    }, 30_000);
});
