// THE DISCLOSURE DECISION, ENFORCED ON EVERY READ TOOL, IN CI.
//
// `REFUSAL_FOR` decides which chain-svc codes a persona may read. `refusalFor`
// applies that decision and writes one operator line when it withholds. Before
// this file, four of the seven paths never called it: `balance`, `resolve`,
// `history` and `contracts` put chain-svc's RAW code straight into `error`, and
// `resolve` forwarded the raw DETAIL as well. Measured at the time, with a fake
// answering `chain_error` on every route: four tools handed the code to the
// persona with ZERO operator log lines. `read` alone was correct, which is how
// we knew the probe could tell them apart.
//
// WHY THIS IS A `bun test` AND NOT ONLY A PROBE ASSERTION. `scripts/mcp-probe.ts`
// checks the same thing over real stdio against a real chain, and it cannot run
// in CI - it needs Docker and Foundry. A guard that only lives there is correct
// on the day it is written and unwatched afterwards, which is exactly how four
// verify scripts rotted unnoticed. The two are not redundant: the probe proves
// it through the transport, this proves it on every push, and only this one
// stops a regression.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, REFUSAL_FOR } from '../src/wallet.ts';
import type { WalletConfig } from '../src/config.ts';

const AGENT = 'orch:vendor';
const TOKEN = 'wallet-token-that-must-never-leak';

const MODULES = {
  schema: 1,
  chainId: 31337,
  treasury: '0xtreasury',
  defaultToken: 'play',
  tokens: [{ key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 }],
  names: { address: '0xreg', tld: 'play' },
};

/// A code the map WITHHOLDS, taken from the map rather than written here - if
/// someone makes `chain_error` persona-facing, this fixture stops describing a
/// withheld code and the test would quietly change meaning.
const WITHHELD = 'chain_error';
/// A code the map CLEARS, same reasoning.
const CLEARED = 'unknown_name';
/// A code no build knows. Distinct from WITHHELD: an unknown code is contract
/// DRIFT, and its log line says so in different words.
const UNDECLARED = 'not_a_code';

let server: Server;
let url: string;
let logs: string[];
let dir: string;
/// What the fake answers next, on every route.
let reply: { status: number; body: unknown };

function walletAt(u: string): Wallet {
  const policyFile = join(dir, 'policy.json');
  writeFileSync(
    policyFile,
    JSON.stringify({
      agentId: AGENT,
      caps: { play: { max_per_tx: 100, max_per_stage: 500 } },
      allow: ['*'],
      deny: [],
      frozen: false,
    }),
  );
  const config: WalletConfig = {
    agentId: AGENT,
    chainSvcUrl: u,
    walletToken: TOKEN,
    policyFile,
    stateFile: join(dir, 'state.json'),
  };
  return new Wallet(config, { log: (m) => logs.push(m), modules: MODULES });
}

beforeEach(async () => {
  logs = [];
  dir = mkdtempSync(join(tmpdir(), 'disclosure-'));
  reply = { status: 502, body: { error: WITHHELD, detail: 'execution reverted at 0xdeadbeef' } };
  server = createServer((_req, res) => {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => server.close());

/// THE FIVE READ TOOLS, driven the way a persona reaches them. Named so a
/// failure says which tool, and listed once so a tool added later without a
/// row here is a visible omission rather than an invisible one.
const READ_TOOLS: Array<[string, (w: Wallet) => Promise<unknown>]> = [
  ['balance', (w) => w.balance()],
  ['resolve', (w) => w.resolve('alpha.play')],
  ['history', (w) => w.history(3)],
  ['contracts', (w) => w.contracts()],
  ['read', (w) => w.read({ contract: 'converter', function: 'quote', args: [] })],
];

describe('every read tool applies the disclosure decision', () => {
  // The fixture is only a fixture if the map still says what it assumes.
  it('the fixture codes are what the map says they are', () => {
    expect(REFUSAL_FOR[WITHHELD]).toBeNull();
    expect(REFUSAL_FOR[CLEARED]).toBe('unknown_name');
    expect(Object.prototype.hasOwnProperty.call(REFUSAL_FOR, UNDECLARED)).toBe(false);
  });

  for (const [name, call] of READ_TOOLS) {
    it(`${name}: a WITHHELD code arrives generic, with exactly one operator line`, async () => {
      const out = (await call(walletAt(url))) as Record<string, unknown>;

      // The persona is told nothing but "it did not happen".
      expect(out).toEqual({ error: 'error' });
      // THE RAW CODE NEVER CROSSES. Asserted on the serialised answer rather
      // than on one field, because the leak this replaces was a code sitting in
      // `error` and a detail sitting beside it.
      expect(JSON.stringify(out)).not.toContain(WITHHELD);
      // ...nor the detail, which is where the sensitive content lives: a
      // withheld code's detail is the thing being withheld.
      expect(JSON.stringify(out)).not.toContain('0xdeadbeef');

      // AND SOMEONE IS TOLD EVERYTHING. That is what makes a generic refusal
      // safe rather than merely opaque: withholding without logging is a fact
      // nobody has.
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(WITHHELD);
    });

    it(`${name}: an UNDECLARED code arrives generic, and is named as drift`, async () => {
      reply = { status: 502, body: { error: UNDECLARED, detail: 'whatever this is' } };
      const out = (await call(walletAt(url))) as Record<string, unknown>;

      expect(out).toEqual({ error: 'error' });
      expect(JSON.stringify(out)).not.toContain(UNDECLARED);
      // Drift between chain-svc and this build is an OPERATOR problem, not a
      // persona problem, and the line says which.
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('does not know');
    });

    it(`${name}: an outage lands in its own key, never in error`, async () => {
      const wallet = walletAt(url);
      await new Promise<void>((r) => server.close(() => r()));
      const out = (await call(wallet)) as Record<string, unknown>;

      expect(Object.keys(out)).toEqual(['unreachable']);
      expect(String(out.unreachable)).toContain('unreachable');
      // An outage is not a refusal and not drift: nothing was decided, so there
      // is nothing for an operator to reconcile.
      expect(logs).toHaveLength(0);
    });
  }

  // THE OTHER DIRECTION, or the rows above pass against a tool that withholds
  // everything. A cleared code must reach the persona WITH its detail - for
  // `resolve` that detail is load-bearing: since §5 a bare `to` has two
  // readings and the refusal has to name both, or a persona reads "no wallet is
  // registered as toby" while `acme:toby` exists and concludes the registry is
  // broken.
  it('a CLEARED code reaches the persona, detail intact, with no operator line', async () => {
    reply = {
      status: 404,
      body: { error: CLEARED, detail: 'no wallet is registered as ghost, nor as orch:ghost' },
    };
    const out = (await walletAt(url).resolve('ghost')) as Record<string, unknown>;

    expect(out.error).toBe('unknown_name');
    expect(String(out.detail)).toContain('orch:ghost');
    expect(logs).toHaveLength(0);
  });

  // The fourth state: a reply that arrived and cannot be used. Not a refusal -
  // nobody decided anything - so it takes the outage's key, because that is its
  // consequence for the persona.
  it('a reply the tool cannot use is unreachable, with the CAUSE in the prose', async () => {
    reply = { status: 200, body: { vee: '250', eth: '1' } };
    expect(await walletAt(url).balance()).toEqual({
      unreachable: 'chain-svc answered without a usable balance',
    });
    expect(logs).toHaveLength(0);
  });

  // The tool's own malformed input is the one case a persona can fix, so it is
  // the one case that carries prose to the persona - in `detail`, never in
  // `error`, which a model switches on.
  it('malformed input answers with the generic code and the prose in detail', async () => {
    const out = (await walletAt(url).read({ contract: '', function: 'quote', args: [] })) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ error: 'error', detail: 'contract is required' });
    expect(logs).toHaveLength(0);
  });
});
