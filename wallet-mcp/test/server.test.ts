// Tools are advertised by the modules a deployment actually has (spec S5 /
// Chain Modules §5), and startup fails hard when it cannot read /modules. Both
// are exercised here: the tool set through a real in-memory MCP client (so the
// assertion is what a model would actually see), and the startup failure through
// the process itself.

import { describe, it, expect, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.ts';
import { fetchModules, type ModulesReply } from '../src/modules.ts';
import type { Wallet } from '../src/wallet.ts';

// listTools never invokes a handler, so a bare stub is enough: the point under
// test is which tools are registered and how they are described, not what they do.
const stubWallet = {} as unknown as Wallet;

async function advertised(modules: ModulesReply): Promise<Array<{ name: string; description?: string }>> {
  const server = buildServer(stubWallet, modules);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => ({ name: t.name, description: t.description }));
}

const modules = (over: Partial<ModulesReply>): ModulesReply => ({
  schema: 1,
  chainId: 31337,
  treasury: '0xtreasury',
  defaultToken: null,
  tokens: [],
  names: null,
  ...over,
});

const TOKEN = { key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 };
const TOKEN_ONLY = modules({ defaultToken: 'play', tokens: [TOKEN] });
const NAMES_ONLY = modules({ names: { address: '0xreg', tld: 'play' } });
const BOTH = modules({ defaultToken: 'play', tokens: [TOKEN], names: { address: '0xreg', tld: 'play' } });
const NEITHER = modules({});

describe('tools advertised by deployed module', () => {
  const names = async (m: ModulesReply): Promise<string[]> => (await advertised(m)).map((t) => t.name).sort();

  /// The three call-op tools are registered on EVERY deployment (§4), so they
  /// appear in every expectation below rather than in a condition.
  ///
  /// UNCONDITIONAL BECAUSE THEY NEED NO MODULE: an empty allowlist yields an
  /// empty menu, and a persona told "nothing is callable" has learned something
  /// true, where a persona whose tool is absent has learned nothing - and the
  /// absence is indistinguishable from a deployment where the op does not
  /// exist. That is the opposite of the money tools, which are hidden precisely
  /// so `module_not_deployed` stays unreachable.
  const CALL_OP = ['call', 'contracts', 'read'];
  const withCallOp = (...tools: string[]) => [...tools, ...CALL_OP].sort();

  it('advertises whoami and the call op only, when there is no token and no names', async () => {
    expect(await names(NEITHER)).toEqual(withCallOp('whoami'));
  });

  it('adds balance, history and send when a default token exists', async () => {
    expect(await names(TOKEN_ONLY)).toEqual(withCallOp('balance', 'history', 'send', 'whoami'));
  });

  it('adds resolve when a names module exists', async () => {
    expect(await names(NAMES_ONLY)).toEqual(withCallOp('resolve', 'whoami'));
  });

  it('advertises all five module tools when both modules are deployed', async () => {
    expect(await names(BOTH)).toEqual(
      withCallOp('balance', 'history', 'resolve', 'send', 'whoami'),
    );
  });

  it('advertises the call op on a deployment with no modules at all', async () => {
    // Stated on its own as well as inside the four above, because it is the
    // property that distinguishes these tools from every other one here.
    expect(await names(NEITHER)).toEqual(expect.arrayContaining(CALL_OP));
  });

  it('carries the default token symbol in the money-tool descriptions', async () => {
    const tools = await advertised(TOKEN_ONLY);
    const description = (name: string) => tools.find((t) => t.name === name)?.description ?? '';
    expect(description('balance')).toContain('PLAY');
    expect(description('history')).toContain('PLAY');
    expect(description('send')).toContain('PLAY');
    // The bug this guards: the old code hardcoded the symbol, so a non-VEE
    // deployment described its money in a currency it does not use.
    expect(description('balance')).not.toContain('VEE');
  });
});

describe('startup reads /modules and fails hard when it cannot', () => {
  let httpServer: Server | undefined;
  afterEach(() => httpServer?.close());

  const config = (chainSvcUrl: string) => ({
    agentId: 'orch:a',
    chainSvcUrl,
    walletToken: 'tok',
    policyFile: '/tmp/unused.json',
    stateFile: '/tmp/unused.state.json',
  });

  async function serverReturning(status: number): Promise<string> {
    httpServer = createServer((_req, res) => {
      res.writeHead(status);
      res.end('x');
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  }

  it('fetchModules rejects on a non-200', async () => {
    const url = await serverReturning(500);
    await expect(fetchModules(config(url))).rejects.toThrow('cannot read /modules');
  });

  it('fetchModules rejects when chain-svc is unreachable', async () => {
    await expect(fetchModules(config('http://127.0.0.1:1'))).rejects.toThrow('cannot read /modules');
  });

  it('the server process exits non-zero when /modules fails', async () => {
    const url = await serverReturning(503);
    const dir = mkdtempSync(join(tmpdir(), 'wm-startup-'));
    const policyFile = join(dir, 'policy.json');
    writeFileSync(
      policyFile,
      JSON.stringify({ agentId: 'orch:a', max_per_tx: 1, max_per_stage: 1, allow: [], deny: [], frozen: false }),
    );

    const proc = Bun.spawn(['bun', 'run', new URL('../src/server.ts', import.meta.url).pathname], {
      env: {
        ...process.env,
        WALLET_AGENT_ID: 'orch:a',
        CHAIN_SVC_URL: url,
        WALLET_TOKEN: 'tok',
        POLICY_FILE: policyFile,
      },
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    // Drain stderr CONCURRENTLY with waiting for exit, never after it: reading a
    // pipe only once the child is gone can lose the reason, and a full pipe could
    // stall the child. Same pattern svc/test/guards.test.ts uses for its own
    // spawned service - which runs at the SAME TIME as this one under the root
    // suite, so this test shares CPU and the libuv threadpool with another real
    // `bun` process.
    let killed = false;
    const cap = setTimeout(() => {
      killed = true;
      proc.kill();
    }, 15_000);
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(cap);

    // A starved or hung child fails BY NAME here rather than as an opaque
    // framework timeout, so the next person reading a red CI job knows which
    // half went wrong.
    if (killed) {
      throw new Error(`wallet-mcp did not exit within 15s; stderr so far: ${JSON.stringify(stderr)}`);
    }
    // stderr first: it names WHY the process gave up, and a failure here prints
    // what was actually received.
    expect(stderr).toContain('cannot read /modules');
    expect(exitCode).not.toBe(0);
    // Generous per-test timeout: spawning a real process competes with the rest
    // of the suite, and a slow-but-correct run must not read as a defect.
  }, 30_000);
});
