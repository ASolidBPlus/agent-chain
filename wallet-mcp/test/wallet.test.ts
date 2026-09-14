// wallet-mcp's behaviour, against a fake chain-svc. The fake records what it
// was asked, so the tests assert what was SENT as well as what came back - a
// double-spend that returned the right txHash would otherwise pass.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Wallet, refusalFor } from '../src/wallet.ts';
import type { WalletConfig } from '../src/config.ts';

const TOKEN = 'wallet-token-that-must-never-leak';
const AGENT = 'orch:vendor';

// The /modules reply the host passes into Wallet (spec S5), now with TWO
// tokens - because every per-token guard in this package filters on one of four
// things, and a fixture whose tokens agree on any of them cannot catch a guard
// that read the wrong one:
//
//   key       play  vs  au       - what the wire and the caps map carry
//   symbol    PLAY  vs  GOLD     - what a persona reads and may write back
//   decimals  18    vs  6        - what an amount is scaled by
//   caps      100   vs  5        - what it is compared against (see AGENT_POLICY)
//
// GOLD IS NOT `AU` UPPER-CASED, deliberately. With a symbol that is just the
// key in capitals, a lookup that searched the wrong namespace would find the
// right token anyway and every test here would pass.
const MODULES = {
  schema: 1,
  chainId: 31337,
  treasury: '0xtreasury',
  defaultToken: 'play',
  tokens: [
    { key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 },
    { key: 'au', address: '0xgold', symbol: 'GOLD', decimals: 6 },
  ],
  names: { address: '0xreg', tld: 'play' },
};

interface Fake {
  url: string;
  server: Server;
  transfers: Array<Record<string, unknown>>;
  headers: Array<Record<string, unknown>>;
  /// What /sign-transfer should answer next.
  reply: { status: number; body: unknown };
  /// Successive answers for GET /intents/:id; the last one repeats.
  intentReplies: Array<{ status: number; body: unknown }>;
  intentQueries: string[];
  names: Record<string, { address: string; canonical: string }>;
  /// Bare names chain-svc refuses as ambiguous rather than resolving (§5).
  ambiguous: string[];
  /// Overrides GET /resolve/:name entirely when set. The resolve path maps
  /// error codes too, and `ambiguous_name` is persona-facing - so without a
  /// way to make resolve answer a GENERIC code, the second mapping site has
  /// no test that reaches its log line at all.
  resolveReply: { status: number; body: unknown } | null;
  /// §4. What POST /call answers next, what GET /calls serves, and what POST
  /// /read answers. Recorded as well as answered, so a test can assert what was
  /// SENT - a call that returned the right hash having sent the wrong arguments
  /// would otherwise pass.
  calls: Array<Record<string, unknown>>;
  reads: Array<Record<string, unknown>>;
  callReply: { status: number; body: unknown };
  readReply: { status: number; body: unknown };
  menu: unknown;
  /// Overrides GET /balance/:name entirely when set - for the shapes an
  /// un-upgraded or failing chain-svc produces.
  balanceReply: { status: number; body: unknown } | null;
  /// The `token` query each /history call carried, or null when it carried
  /// none. What was SENT, not only what came back: a filter that resolved the
  /// right token and then failed to put it on the wire would return the
  /// default's rows and look correct.
  historyQueries: Array<string | null>;
}

async function fakeChainSvc(): Promise<Fake> {
  const state: Fake = {
    url: '',
    server: null as unknown as Server,
    transfers: [],
    headers: [],
    reply: { status: 200, body: { txHash: '0xtx1' } },
    intentReplies: [],
    intentQueries: [],
    // Names the registry refuses as AMBIGUOUS: a bare form that is both a
    // registered name and a peer in the caller's namespace (§5). chain-svc
    // answers 409 rather than picking one, and the fake has to model that or
    // wallet-mcp's half of the refusal is untested.
    ambiguous: [],
    resolveReply: null,
    calls: [],
    reads: [],
    callReply: { status: 200, body: { txHash: '0xcall1' } },
    readReply: { status: 200, body: { result: '40' } },
    menu: { calls: [] },
    balanceReply: null,
    historyQueries: [],
    names: {
      'alpha.play': { address: '0xaaa', canonical: 'alpha:client' },
      'treasury.play': { address: '0xttt', canonical: 'treasury.play' },
      [AGENT]: { address: '0xme', canonical: AGENT },
    },
  };

  state.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname.startsWith('/resolve/')) {
        if (state.resolveReply) return json(state.resolveReply.status, state.resolveReply.body);
        const name = decodeURIComponent(url.pathname.slice('/resolve/'.length));
        if (state.ambiguous.includes(name)) {
          return json(409, {
            error: 'ambiguous_name',
            detail: `${name} is both a registered name and a wallet in your namespace`,
          });
        }
        const found = state.names[name];
        // chain-svc sends a DETAIL naming both readings it tried. The fake has
        // to as well, or a test cannot tell propagation from reconstruction.
        return found
          ? json(200, found)
          : json(404, { error: 'unknown_name', detail: `no wallet is registered as ${name}, nor as orch:${name}` });
      }
      if (url.pathname.startsWith('/reverse/')) return json(200, { canonical: AGENT, aliases: ['vendor.play'] });
      // chain-svc's reply since §2: a map KEYED BY SYMBOL, the default named,
      // and the legacy single-token `vee` still beside them for one release.
      // The legacy field is in the fixture ON PURPOSE - a reader that fell back
      // to it would otherwise have nothing to fall back TO, and the test that
      // forbids the fallback would pass vacuously.
      if (url.pathname.startsWith('/balance/')) {
        if (state.balanceReply) return json(state.balanceReply.status, state.balanceReply.body);
        return json(200, { balances: { PLAY: '250', GOLD: '9.5' }, default: 'PLAY', eth: '1', vee: '250' });
      }
      // ONE TOKEN PER CALL, chosen by `?token=`, which is a KEY on the wire.
      // The rows differ by token so a filter that ignored the query string
      // would return the wrong amounts rather than the same ones.
      if (url.pathname.startsWith('/history/')) {
        state.historyQueries.push(url.searchParams.get('token'));
        const rows: Record<string, Array<Record<string, unknown>>> = {
          play: [
            { txHash: '0xh1', from: AGENT, to: 'alpha:client', amount: '50', vee: '50', token: 'PLAY', blockNumber: '7', memo: 'stream job' },
            { txHash: '0xh2', from: 'alpha:client', to: AGENT, amount: '5', vee: '5', token: 'PLAY', blockNumber: '6' },
          ],
          au: [
            { txHash: '0xg1', from: AGENT, to: 'alpha:client', amount: '2.5', vee: '2.5', token: 'GOLD', blockNumber: '9' },
          ],
        };
        return json(200, rows[url.searchParams.get('token') ?? 'play'] ?? []);
      }
      if (url.pathname.startsWith('/intents/')) {
        const id = decodeURIComponent(url.pathname.slice('/intents/'.length));
        state.intentQueries.push(id);
        const next =
          state.intentReplies.length > 1 ? state.intentReplies.shift()! : state.intentReplies[0];
        return next ? json(next.status, next.body) : json(404, { error: 'unknown_name' });
      }
      if (url.pathname === '/calls') return json(200, state.menu);
      if (url.pathname === '/call') {
        state.calls.push(JSON.parse(body || '{}'));
        return json(state.callReply.status, state.callReply.body);
      }
      if (url.pathname === '/read') {
        state.reads.push(JSON.parse(body || '{}'));
        return json(state.readReply.status, state.readReply.body);
      }
      if (url.pathname === '/sign-transfer') {
        state.transfers.push(JSON.parse(body || '{}'));
        state.headers.push({ ...req.headers });
        return json(state.reply.status, state.reply.body);
      }
      return json(404, { error: 'invalid_request' });
    });
  });

  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(state.server.address() as { port: number }).port}`;
  return state;
}

let fake: Fake;
let dir: string;

function walletWith(policy: Record<string, unknown> | null): {
  wallet: Wallet;
  config: WalletConfig;
  logs: string[];
} {
  const policyFile = join(dir, 'policy.json');
  if (policy) writeFileSync(policyFile, JSON.stringify(policy));
  const config: WalletConfig = {
    agentId: AGENT,
    chainSvcUrl: fake.url,
    walletToken: TOKEN,
    policyFile,
    stateFile: join(dir, 'state.json'),
  };
  const logs: string[] = [];
  return { wallet: new Wallet(config, { log: (m) => logs.push(m), modules: MODULES }), config, logs };
}

// Caps are PER TOKEN and keyed by KEY, and the two tokens' caps differ - so a
// check that reached for the wrong entry refuses a send these tests expect to
// succeed, rather than agreeing by coincidence.
const AGENT_POLICY = {
  agentId: AGENT,
  caps: {
    play: { max_per_tx: 100, max_per_stage: 500 },
    au: { max_per_tx: 5, max_per_stage: 20 },
  },
  allow: ['*.play'],
  deny: ['treasury.play'],
  frozen: false,
};

beforeEach(async () => {
  fake = await fakeChainSvc();
  dir = mkdtempSync(join(tmpdir(), 'wallet-mcp-'));
});
afterEach(() => fake.server.close());

describe('send', () => {
  it('sends to a name and returns the txHash', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.send({ to: 'alpha.play', amount: '50', intent_id: 'a1', memo: 'stream job' })).toEqual({
      ok: true,
      txHash: '0xtx1',
    });
    expect(fake.transfers).toHaveLength(1);
    // `amount` and the token's KEY on the wire - never `vee`, and never the
    // symbol the caller may have written.
    expect(fake.transfers[0]).toMatchObject({
      to: 'alpha.play', amount: '50', token: 'play', intentId: 'a1', memo: 'stream job',
    });
    expect(fake.transfers[0]!.vee).toBeUndefined();
  });

  // Criterion 4: the same call again returns the SAME txHash and the money
  // moves once. Asserting the txHash alone would pass even if it sent twice,
  // so the fake's record of what it received is the real assertion.
  it('replays an identical intent without sending again', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const first = await wallet.send({ to: 'alpha.play', amount: '50', intent_id: 'a1' });
    const second = await wallet.send({ to: 'alpha.play', amount: '50', intent_id: 'a1' });

    expect(second).toEqual(first);
    expect(fake.transfers).toHaveLength(1);
  });

  // Reusing an intent id for a DIFFERENT payment is the mistake the reason
  // exists to name - and it must not silently send.
  it('refuses an intent id reused for a different payment', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    await wallet.send({ to: 'alpha.play', amount: '50', intent_id: 'a1' });
    const result = await wallet.send({ to: 'alpha.play', amount: '75', intent_id: 'a1' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('duplicate_intent');
    expect(fake.transfers).toHaveLength(1);
  });

  it('survives a restart without forgetting an intent', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    await wallet.send({ to: 'alpha.play', amount: '50', intent_id: 'a1' });

    const { wallet: reborn } = walletWith(AGENT_POLICY); // fresh process, same state file
    expect(await reborn.send({ to: 'alpha.play', amount: '50', intent_id: 'a1' })).toEqual({ ok: true, txHash: '0xtx1' });
    expect(fake.transfers).toHaveLength(1);
  });

  it('refuses over max_per_tx locally, without troubling chain-svc', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const result = await wallet.send({ to: 'alpha.play', amount: '150', intent_id: 'b1' });

    expect(result).toMatchObject({ ok: false, reason: 'over_max_per_tx' });
    expect(fake.transfers).toHaveLength(0);
  });

  it('refuses a denied counterparty', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.send({ to: 'treasury.play', amount: '1', intent_id: 'c1' })).toMatchObject({
      ok: false,
      reason: 'counterparty_denied',
    });
    expect(fake.transfers).toHaveLength(0);
  });

  // Criterion 9's shape at the tool: a bare local id is not a registered name.
  it('refuses an unknown name and a bare local id', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.send({ to: 'nobody.play', amount: '1', intent_id: 'd1' })).toMatchObject({
      ok: false,
      reason: 'unknown_name',
    });
    expect(await wallet.send({ to: 'client', amount: '1', intent_id: 'd2' })).toMatchObject({
      ok: false,
      reason: 'unknown_name',
    });
    expect(fake.transfers).toHaveLength(0);
  });

  // DO NOT FLATTEN, on the RESOLUTION side. Since §5 a bare `to` has two
  // readings, and chain-svc's refusal names both. Rebuilding that sentence here
  // would be a second authority for one fact: the two would drift the first
  // time either side reworded it, and the persona would be told only half of
  // what was tried.
  //
  // Measured: replacing the propagated detail with a locally-built
  // "no wallet is registered as <to>" survived every other test in this file.
  it("passes chain-svc's own detail through, rather than inventing one", async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const result = await wallet.send({ to: 'ghost', amount: '1', intent_id: 'd3' });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_name' });
    // BOTH readings, which only the authority knows about.
    expect((result as { detail?: string }).detail).toContain('orch:ghost');
  });

  // A bare id that collides with a registered name is refused, not guessed, and
  // reaches the persona as its OWN reason - not flattened into unknown_name,
  // which would say "no wallet" when the problem is that there are two.
  it('surfaces ambiguous_name as its own reason', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.ambiguous.push('toby');
    const result = await wallet.send({ to: 'toby', amount: '1', intent_id: 'd4' });
    expect(result).toMatchObject({ ok: false, reason: 'ambiguous_name' });
    expect((result as { detail?: string }).detail).toContain('both');
  });

  // ── The closed refusal set ────────────────────────────────────────────────
  //
  // A persona-facing code carries chain-svc's own detail; a generic one carries
  // NOTHING, and the real code goes to the facilitator instead. The generic
  // mapping is only safe because of that second half - without the log it is
  // opaque rather than protective, and contract drift becomes invisible.

  it('passes a persona-facing code through WITH its detail', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'over_max_per_tx', detail: 'max_per_tx is 100 VEE' } };
    expect(await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'r1' })).toMatchObject({
      ok: false,
      reason: 'over_max_per_tx',
      detail: 'max_per_tx is 100 VEE',
    });
  });

  // ⛔ THE CODE ITSELF IS A DETAIL. Handing back `not_your_wallet` undoes the
  // disclosure decision with an argument that looks like helpfulness.
  it('gives a generic code NO detail, not even the code', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 403, body: { error: 'not_your_wallet', detail: 'orch:someone-else' } };
    const result = await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'r2' });
    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(JSON.stringify(result)).not.toContain('not_your_wallet');
    expect(JSON.stringify(result)).not.toContain('orch:someone-else');
  });

  it('logs the real code for the facilitator when it maps to generic', () => {
    const lines: string[] = [];
    expect(refusalFor('internal_error', (m) => lines.push(m))).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('internal_error');
  });

  // Drift: the wire can carry a code this build does not declare. That is
  // facilitator business, and it must not reach the persona as anything but
  // generic.
  it('treats an undeclared code as generic and names it as drift', () => {
    const lines: string[] = [];
    expect(refusalFor('a_code_from_the_future', (m) => lines.push(m))).toBeNull();
    expect(lines[0]).toContain('a_code_from_the_future');
    expect(lines[0]).toContain('drift');
  });

  it('does not log for a persona-facing code — the persona was told', () => {
    const lines: string[] = [];
    expect(refusalFor('unknown_name', (m) => lines.push(m))).toBe('unknown_name');
    expect(lines).toHaveLength(0);
  });

  // #99. The two tests above prove the sink is USED when one is handed in.
  // Neither proves the console is not used as well, and that is the whole
  // question: org-core imports this as a library, so the global console is
  // ORG-CORE's and is shared with every package in that process. A code
  // withheld from the persona over the tool boundary must not come back on a
  // channel the persona's neighbours can read.
  //
  // So this replaces console.error for the duration and asserts it stays
  // untouched THROUGH A REAL SEND, not through refusalFor directly - the leak
  // that shipped was at a call site, not in the function.
  it('writes the facilitator line to the injected sink and NOT to the console', async () => {
    const { wallet, logs } = walletWith(AGENT_POLICY);
    fake.reply = { status: 403, body: { error: 'not_your_wallet', detail: 'orch:someone-else' } };

    const original = console.error;
    const stolen: unknown[] = [];
    console.error = (...args: unknown[]) => { stolen.push(args); };
    try {
      await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'log-1' });
    } finally {
      console.error = original;
    }

    expect(logs.some((l) => l.includes('not_your_wallet'))).toBe(true);
    // An eavesdropping package in org-core's process learns nothing.
    expect(stolen).toHaveLength(0);
  });

  // The resolve path maps codes too, and it is the site where the FIRST leak
  // survived a fix aimed at the other one. A sink threaded into only one of
  // the two call sites passes the test above.
  it('routes the resolve path through the same sink', async () => {
    const { wallet, logs } = walletWith(AGENT_POLICY);
    fake.resolveReply = { status: 500, body: { error: 'internal_error' } };

    const original = console.error;
    const stolen: unknown[] = [];
    console.error = (...args: unknown[]) => { stolen.push(args); };
    try {
      await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'log-2' });
    } finally {
      console.error = original;
    }

    expect(logs.some((l) => l.includes('internal_error'))).toBe(true);
    expect(stolen).toHaveLength(0);
  });

  it('refuses when the policy file says frozen', async () => {
    const { wallet } = walletWith({ ...AGENT_POLICY, frozen: true });
    expect(await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'e1' })).toMatchObject({
      ok: false,
      reason: 'frozen',
    });
    expect(fake.transfers).toHaveLength(0);
  });

  // The stage cap needs server state this process cannot see, so it arrives
  // from chain-svc and is surfaced verbatim rather than guessed at locally.
  it('surfaces a server-side refusal as its own reason', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'over_stage_cap', detail: 'max_per_stage is 500 VEE' } };

    expect(await wallet.send({ to: 'alpha.play', amount: '100', intent_id: 'f1' })).toMatchObject({
      ok: false,
      reason: 'over_stage_cap',
    });
  });

  // A refused send must stay retryable: nothing is recorded, so the same intent
  // id can be used again once the cap resets.
  it('does not record a refused send', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'over_stage_cap' } };
    await wallet.send({ to: 'alpha.play', amount: '100', intent_id: 'g1' });

    fake.reply = { status: 200, body: { txHash: '0xlater' } };
    expect(await wallet.send({ to: 'alpha.play', amount: '100', intent_id: 'g1' })).toEqual({ ok: true, txHash: '0xlater' });
  });

  // An unmapped chain-svc code must NOT become a plausible-looking refusal:
  // telling a persona "counterparty_denied" when the truth was a 502 teaches it
  // something false about the game.
  it('does not dress an unexpected failure up as a policy refusal', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 502, body: { error: 'chain_error', detail: 'reverted' } };

    const result = await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'h1' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('error');
  });

  it('sends the wallet-mcp marker so chain-svc can tag the spend', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'i1' });
    expect(fake.headers[0]!['x-wallet-client']).toMatch(/^wallet-mcp\//);
  });
});

describe('reads', () => {
  it('reports who it is, with its aliases', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.whoami()).toEqual({
      agentId: AGENT,
      address: '0xme',
      aliases: ['vendor.play'],
      // SYMBOLS, which is what a persona reads everywhere else in this package.
      tokens: ['PLAY', 'GOLD'],
    });
  });

  it('labels history by direction and names the counterparty', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const entries = (await wallet.history()) as Array<Record<string, unknown>>;

    expect(entries[0]).toMatchObject({ direction: 'out', counterparty: 'alpha:client', amount: '50', token: 'PLAY' });
    expect(entries[1]).toMatchObject({ direction: 'in', counterparty: 'alpha:client', amount: '5', token: 'PLAY' });
    // The legacy field is not carried through, even though the row still has it.
    expect(entries[0]!.vee).toBeUndefined();
  });

  it('resolves a name to an address and a canonical id', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.resolve('alpha.play')).toEqual({ address: '0xaaa', canonical: 'alpha:client' });
    expect(await wallet.resolve('nobody.play')).toMatchObject({ error: expect.any(String) });
  });
});

// §3. The deployment has two tokens, and every money path has to say WHICH.
//
// The fixture's tokens disagree in key, symbol, caps and decimals (see MODULES
// and AGENT_POLICY), so each case below distinguishes "read the named token"
// from "read the default and get away with it".
describe('one wallet, two tokens', () => {
  it('reports every token\'s balance, and which one is the default', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.balance()).toEqual({
      // KEYED BY SYMBOL, which is what chain-svc sends and what a persona reads.
      balances: { PLAY: '250', GOLD: '9.5' },
      default: 'PLAY',
    });
  });

  // The legacy single-token field is still in the fixture reply. Falling back to
  // it would PASS for the whole deprecation window while silently reporting one
  // token, and break only once the field went - so the window in which anyone
  // could notice is exactly the window in which nothing looks wrong.
  it('fails loudly on a chain-svc too old to send balances, rather than reading vee', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.balanceReply = { status: 200, body: { vee: '250', eth: '1' } };
    expect(await wallet.balance()).toEqual({ error: 'balance unavailable' });
  });

  it('sends the default token when none is named', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.send({ to: 'alpha.play', amount: '50', intent_id: 'd1' })).toMatchObject({ ok: true });
    expect(fake.transfers[0]).toMatchObject({ amount: '50', token: 'play' });
  });

  // Either namespace, either case - and the KEY is what goes on the wire
  // whichever one the caller wrote, because the key is what chain-svc stores.
  it('accepts a token by key or by symbol, case-insensitively', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    for (const [i, written] of ['au', 'AU', 'GOLD', 'gold'].entries()) {
      expect(await wallet.send({ to: 'alpha.play', amount: '1', token: written, intent_id: `e${i}` }))
        .toMatchObject({ ok: true });
      expect(fake.transfers[i]).toMatchObject({ token: 'au' });
    }
  });

  // The cap that applies is the NAMED token's. 50 is under PLAY's 100 and over
  // GOLD's 5, so one amount gets two answers - and the refusal never reaches
  // chain-svc, which is the point of a local pre-check.
  it('caps the named token by its own limit', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.send({ to: 'alpha.play', amount: '50', intent_id: 'f1' })).toMatchObject({ ok: true });
    expect(await wallet.send({ to: 'alpha.play', amount: '50', token: 'GOLD', intent_id: 'f2' })).toMatchObject({
      ok: false,
      reason: 'over_max_per_tx',
    });
    expect(fake.transfers).toHaveLength(1);
  });

  // A readable policy that says nothing about this token is a REFUSAL, not a
  // deferral: an absent cap read as "no limit" is the one reading that costs
  // money. (An UNREADABLE policy still defers - see policy.test.ts.)
  it('refuses a token the policy sets no cap for', async () => {
    const { wallet } = walletWith({ ...AGENT_POLICY, caps: { play: { max_per_tx: 100, max_per_stage: 500 } } });
    const result = await wallet.send({ to: 'alpha.play', amount: '1', token: 'GOLD', intent_id: 'g1' });
    expect(result).toMatchObject({ ok: false, reason: 'over_max_per_tx' });
    expect(result.detail).toContain('au');
    expect(fake.transfers).toHaveLength(0);
  });

  it('refuses a token this deployment does not have, and says what it does', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const result = await wallet.send({ to: 'alpha.play', amount: '1', token: 'ETH', intent_id: 'h1' });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_token' });
    expect(result.detail).toContain('play (PLAY)');
    expect(result.detail).toContain('au (GOLD)');
    expect(fake.transfers).toHaveLength(0);
  });

  // A model that writes `{"token": 4}` is told what a token IS. Not
  // `unknown_token`, which would send it looking for the right spelling of 4.
  it('refuses a token that is not a string as bad input', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const result = await wallet.send({ to: 'alpha.play', amount: '1', token: 4, intent_id: 'h2' });
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect(result.detail).toContain('must be a string');
    expect(fake.transfers).toHaveLength(0);
  });

  // The token is PART OF WHAT MAKES A REPLAY A REPLAY. Same id, same
  // counterparty, same amount, different token is a DIFFERENT payment - and
  // answering it with the first one's txHash would report a GOLD transfer that
  // never happened as settled.
  it('treats the same intent id under a different token as a different payment', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const first = await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'i1' });
    expect(first).toMatchObject({ ok: true });

    const second = await wallet.send({ to: 'alpha.play', amount: '1', token: 'GOLD', intent_id: 'i1' });
    expect(second).toMatchObject({ ok: false, reason: 'duplicate_intent' });
    // And it says which token the id was spent on, by SYMBOL - the ledger holds
    // the key, and a persona reading "already used to send 1 au" would be told
    // the id was spent on something it has never seen named.
    expect(second.detail).toContain('1 PLAY');
    expect(fake.transfers).toHaveLength(1);

    // The identical send under the same token is still a replay.
    expect(await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'i1' })).toEqual(first);
    expect(fake.transfers).toHaveLength(1);
  });

  // ONE TOKEN PER CALL (chain-svc's rule): a merged history would interleave
  // amounts in different scales under one field. So the filter has to reach the
  // wire, not just the resolver.
  it('asks for one token\'s history and puts the key on the wire', async () => {
    const { wallet } = walletWith(AGENT_POLICY);

    const play = (await wallet.history()) as Array<Record<string, unknown>>;
    expect(play.map((e) => e.token)).toEqual(['PLAY', 'PLAY']);

    const gold = (await wallet.history(20, 'GOLD')) as Array<Record<string, unknown>>;
    expect(gold).toHaveLength(1);
    expect(gold[0]).toMatchObject({ direction: 'out', amount: '2.5', token: 'GOLD' });

    // Written as a symbol, sent as a key - both times.
    expect(fake.historyQueries).toEqual(['play', 'au']);
  });

  it('refuses history for a token this deployment does not have, BY CODE', async () => {
    // The CODE in `error` and the sentence in `detail`, which is `send`'s shape
    // for the identical resolution. Asserting only that the sentence appeared
    // let the two paths drift: one rule reached a persona as `unknown_token`
    // through `send` and as free text through `history`, and the closed set of
    // reasons is exactly what a model is supposed to be able to switch on.
    //
    // Caught by the stdio smoke, not by this suite - because this assertion
    // was satisfied by the detail whichever field carried it.
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.history(20, 'ETH')).toMatchObject({
      error: 'unknown_token',
      detail: expect.stringContaining('no token "ETH"'),
    });
    expect(fake.historyQueries).toHaveLength(0);
  });
});

// Spec S5 secret hygiene, tested rather than asserted. the harness's transcript
// redactor does NOT cover WALLET_TOKEN, so anything this returns is written to
// the on-disk transcript in plaintext and streamed to the harness event feed.
describe('the wallet token never reaches the model', () => {
  it('appears in no tool result or error, on any path', async () => {
    const { wallet } = walletWith(AGENT_POLICY);

    const outputs: unknown[] = [
      await wallet.whoami(),
      await wallet.balance(),
      await wallet.resolve('alpha.play'),
      await wallet.resolve('nobody.play'),
      await wallet.history(),
      await wallet.send({ to: 'alpha.play', amount: '50', intent_id: 'z1' }),
      await wallet.send({ to: 'alpha.play', amount: '150', intent_id: 'z2' }),
      await wallet.send({ to: 'nobody.play', amount: '1', intent_id: 'z3' }),
      await wallet.send({ to: 'treasury.play', amount: '1', intent_id: 'z4' }),
      await wallet.send({ to: '', amount: '1', intent_id: 'z5' }),
    ];

    for (const out of outputs) {
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    }

    // A known-positive control: if the token were in one of these, this test
    // must be capable of seeing it. Without this, a matcher that never matches
    // reports every output as clean.
    expect(JSON.stringify({ leak: TOKEN })).toContain(TOKEN);
  });

  // chain-svc echoing the token back is the shape a misconfigured error would
  // take, and the redactor is the last line rather than the first.
  it('strips it even if chain-svc echoes it back', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 500, body: { error: 'chain_error', detail: `bad bearer ${TOKEN}` } };

    const result = await wallet.send({ to: 'alpha.play', amount: '1', intent_id: 'y1' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('keeps it out of the state file on disk', async () => {
    const { wallet, config } = walletWith(AGENT_POLICY);
    await wallet.send({ to: 'alpha.play', amount: '50', intent_id: 'x1' });
    expect(readFileSync(config.stateFile, 'utf8')).not.toContain(TOKEN);
  });
});

// Spec S5, ruled. The model must never see the broadcast-to-record
// window, because the obvious action on it - send again - is the double charge.
describe('reconciling an unresolved intent', () => {
  const send = { to: 'alpha.play', amount: '10', intent_id: 'i-recon' };

  it('polls until confirmed and returns ONE txHash for ONE transfer', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'intent_unresolved', detail: 'reserved, no hash' } };
    fake.intentReplies = [
      { status: 200, body: { intentId: 'i-recon', status: 'reserved' } },
      { status: 200, body: { intentId: 'i-recon', status: 'confirmed', txHash: '0xsettled' } },
    ];

    const res = await wallet.send(send);

    expect(res).toEqual({ ok: true, txHash: '0xsettled' });
    // THE PROPERTY. Reconciling must not re-send: one POST, whatever the polling did.
    expect(fake.transfers).toHaveLength(1);
    expect(fake.intentQueries.length).toBeGreaterThan(1);
  }, 15_000);

  // And the persona's own retry is answered from the ledger the reconciliation
  // wrote, so a second ask is still not a second transfer.
  it('a persona re-send after reconciliation returns the same hash and sends nothing', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'intent_unresolved' } };
    fake.intentReplies = [{ status: 200, body: { status: 'confirmed', txHash: '0xsettled' } }];

    await wallet.send(send);
    const before = fake.transfers.length;
    const again = await wallet.send(send);

    expect(again).toEqual({ ok: true, txHash: '0xsettled' });
    expect(fake.transfers).toHaveLength(before);
  }, 15_000);

  it('reports a reverted transfer as nothing moved, not as unresolved', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'intent_unresolved' } };
    fake.intentReplies = [{ status: 200, body: { status: 'failed', txHash: '0xrevert' } }];

    const res = await wallet.send(send);
    expect(res.ok).toBe(false);
    // Named from the DEPLOYED token's symbol, not from a literal: the fixture
    // above declares it, so the wording follows the deployment rather than
    // restating it here and drifting when the fixture changes.
    expect(res.detail).toContain(`no ${MODULES.tokens[0].symbol} moved`);
    expect(fake.transfers).toHaveLength(1);
  }, 15_000);


  // The one case the model DOES see. It gets the instruction that matters -
  // retry the same id - rather than a bare failure it would answer by re-sending.
  it('surfaces intent_unresolved when it never settles, and still sends only once', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'intent_unresolved' } };
    fake.intentReplies = [{ status: 200, body: { status: 'reserved' } }];

    const res = await wallet.send({ to: 'alpha.play', amount: '10', intent_id: 'i-never' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('intent_unresolved');
    expect(res.detail).toContain('Do NOT re-send');
    expect(res.detail).toContain('i-never');
    expect(fake.transfers).toHaveLength(1);
  }, 20_000);
});

// Amendment (a). The honest error existed one call away and was thrown out at
// the mapping, so an outage reached the persona as "that name does not exist".
describe('a chain-svc outage is not reported as an unknown name', () => {
  function offlineWallet(): Wallet {
    return new Wallet({
      agentId: AGENT,
      chainSvcUrl: 'http://127.0.0.1:1', // nothing listens; connection refused
      walletToken: TOKEN,
      policyFile: join(dir, 'policy.json'),
      stateFile: join(dir, 'state-offline.json'),
    }, { log: () => {}, modules: MODULES });
  }

  it('surfaces the transport failure instead of flattening to unknown_name', async () => {
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(AGENT_POLICY));
    const res = await offlineWallet().send({ to: 'alpha.play', amount: '10', intent_id: 'off-1' });

    expect(res.ok).toBe(false);
    // THE POINT: not unknown_name. A student debugging this must not be sent
    // looking for a registration bug that does not exist.
    expect(res.reason).not.toBe('unknown_name');
    expect(res.detail).toContain('unreachable');
  });

  it('still reports a genuinely unregistered name as unknown_name', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const res = await wallet.send({ to: 'nobody.play', amount: '10', intent_id: 'off-2' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_name');
  });

  // The two must be DISTINGUISHABLE, which is the property that was broken:
  // previously both produced byte-identical results.
  it('gives the two cases different answers', async () => {
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(AGENT_POLICY));
    const outage = await offlineWallet().send({ to: 'alpha.play', amount: '10', intent_id: 'off-3' });
    const { wallet } = walletWith(AGENT_POLICY);
    const missing = await wallet.send({ to: 'nobody.play', amount: '10', intent_id: 'off-4' });

    expect(JSON.stringify(outage)).not.toBe(JSON.stringify(missing));
  });
});

// §4 / §8.7. THE THREE CALL-OP TOOLS.
//
// The fake records what was SENT as well as what it answered, for the reason
// the file's header gives about transfers: a call that returned the right hash
// having sent the wrong arguments would pass a test that only read the reply.
describe('the call op', () => {
  const CALL = {
    contract: 'converter',
    function: 'convert',
    args: [{ token: 'play' }, { token: 'gold' }, '40'],
    intent_id: 'c-1',
  };

  describe('contracts', () => {
    it('passes the menu through as chain-svc served it', async () => {
      // NOT RESHAPED HERE. The menu is what the model reads to learn what an
      // argument takes, and two places deciding its shape is how the tool
      // description and the server's answer drift apart.
      fake.menu = {
        calls: [
          {
            contract: 'converter',
            function: 'convert',
            read: false,
            params: [
              { name: 'source', type: 'address', accepts: 'token' },
              { name: 'amountIn', type: 'uint256', accepts: 'amount:per-call' },
            ],
            maxPerStage: 20,
          },
        ],
      };
      const { wallet } = walletWith(AGENT_POLICY);
      expect(await wallet.contracts()).toEqual(fake.menu);
    });

    it('is not cached: a second call re-reads the file', async () => {
      // A scenario may rewrite calls.json between turns, and a menu that lagged
      // it would advertise calls that are no longer permitted - the one
      // direction that matters, because a persona acts on what the menu says.
      const { wallet } = walletWith(AGENT_POLICY);
      fake.menu = { calls: [] };
      expect(await wallet.contracts()).toEqual({ calls: [] });
      fake.menu = { calls: [{ contract: 'shop', function: 'buy', read: false, params: [] }] };
      expect(await wallet.contracts()).toEqual(fake.menu);
    });

    it('reports an outage as an outage', async () => {
      const { wallet } = walletWith(AGENT_POLICY);
      await new Promise<void>((r) => fake.server.close(() => r()));
      expect(await wallet.contracts()).toEqual({ error: expect.stringContaining('unreachable') });
    });
  });

  describe('call', () => {
    it('sends exactly what the model asked for', async () => {
      const { wallet } = walletWith(AGENT_POLICY);
      expect(await wallet.call(CALL)).toEqual({ ok: true, txHash: '0xcall1' });
      expect(fake.calls).toEqual([
        {
          contract: 'converter',
          function: 'convert',
          args: [{ token: 'play' }, { token: 'gold' }, '40'],
          intentId: 'c-1',
        },
      ]);
    });

    it('returns the original hash for a replay, and sends nothing', async () => {
      const { wallet } = walletWith(AGENT_POLICY);
      await wallet.call(CALL);
      expect(await wallet.call(CALL)).toEqual({ ok: true, txHash: '0xcall1' });
      expect(fake.calls).toHaveLength(1);
    });

    it('refuses the same intent_id with different arguments', async () => {
      // The refusal only this side can see. chain-svc refuses it too - this is
      // the same rule applied earlier, from this side's own record, and both
      // hash the same wire arguments so the two cannot disagree.
      const { wallet } = walletWith(AGENT_POLICY);
      await wallet.call(CALL);
      const again = await wallet.call({ ...CALL, args: [{ token: 'play' }, { token: 'gold' }, '41'] });
      expect(again).toMatchObject({ ok: false, reason: 'duplicate_intent' });
      expect(fake.calls).toHaveLength(1);
    });

    it('refuses an intent_id already used for a SEND, and says which', async () => {
      const { wallet } = walletWith(AGENT_POLICY);
      await wallet.send({ to: 'alpha.play', amount: '10', intent_id: 'shared' });
      const call = await wallet.call({ ...CALL, intent_id: 'shared' });
      expect(call).toMatchObject({ ok: false, reason: 'duplicate_intent' });
      expect((call as { detail?: string }).detail).toContain('send');
    });

    it('refuses a send under an intent_id already used for a CALL', async () => {
      // The mirror, and it is not symmetry for its own sake: a call remembered
      // as a transfer would answer a repeat of the call with duplicate_intent
      // about a payment nobody made.
      const { wallet } = walletWith(AGENT_POLICY);
      await wallet.call({ ...CALL, intent_id: 'shared2' });
      const send = await wallet.send({ to: 'alpha.play', amount: '10', intent_id: 'shared2' });
      expect(send).toMatchObject({ ok: false, reason: 'duplicate_intent' });
      expect((send as { detail?: string }).detail).toContain('call');
    });

    it('surfaces the four new refusals by name, with their detail', async () => {
      const { wallet } = walletWith(AGENT_POLICY);
      for (const [error, detail] of [
        ['unknown_contract', 'no contract "bazaar" in this deployment'],
        ['function_not_allowed', 'convert is not callable on converter'],
        ['bad_args', 'argument 2 (amountIn): expected uint256'],
      ] as const) {
        fake.callReply = { status: 400, body: { error, detail } };
        const out = await wallet.call({ ...CALL, intent_id: `r-${error}` });
        expect(out).toEqual({ ok: false, reason: error, detail });
      }
    });

    it('carries no reason with a revert', async () => {
      // The CODE crosses to the persona and the REASON does not: a revert
      // string is the contract's internal state, and the game's machinery is
      // not a player's to read. chain-svc already withholds it; this asserts
      // that wallet-mcp does not invent one.
      const { wallet } = walletWith(AGENT_POLICY);
      fake.callReply = {
        status: 409,
        body: { error: 'revert', detail: 'the call was mined and reverted; nothing changed' },
      };
      const out = await wallet.call({ ...CALL, intent_id: 'rev-1' });
      expect(out).toMatchObject({ ok: false, reason: 'revert' });
      expect(JSON.stringify(out)).not.toMatch(/pair|paused|insufficient/i);
    });

    it('withholds a code that is not persona-facing, and logs it', async () => {
      const { wallet, logs } = walletWith(AGENT_POLICY);
      fake.callReply = { status: 403, body: { error: 'not_your_wallet', detail: 'belongs to someone else' } };
      expect(await wallet.call({ ...CALL, intent_id: 'g-1' })).toEqual({ ok: false, reason: 'error' });
      expect(logs.join('\n')).toContain('not_your_wallet');
    });

    it('tells the model to retry with the SAME id when the outcome is unknown', async () => {
      const { wallet } = walletWith(AGENT_POLICY);
      fake.callReply = { status: 409, body: { error: 'intent_unresolved' } };
      fake.intentReplies = [{ status: 200, body: { status: 'confirmed', txHash: '0xlate' } }];
      const out = await wallet.call({ ...CALL, intent_id: 'u-1' });
      expect(out).toEqual({ ok: true, txHash: '0xlate' });
      expect(fake.intentQueries).toContain('u-1');
    });

    it('remembers a reconciled call as a CALL, so a repeat is a replay', async () => {
      // The shape recorded by the reconcile is what a later repeat is compared
      // against. Recording it as a transfer would make the repeat a
      // duplicate_intent about a payment nobody made.
      const { wallet } = walletWith(AGENT_POLICY);
      fake.callReply = { status: 409, body: { error: 'intent_unresolved' } };
      fake.intentReplies = [{ status: 200, body: { status: 'confirmed', txHash: '0xlate' } }];
      await wallet.call({ ...CALL, intent_id: 'u-2' });
      expect(await wallet.call({ ...CALL, intent_id: 'u-2' })).toEqual({ ok: true, txHash: '0xlate' });
    });

    it('refuses its own malformed input before it reaches the wire', async () => {
      const { wallet } = walletWith(AGENT_POLICY);
      for (const bad of [
        { ...CALL, contract: '' },
        { ...CALL, function: '' },
        { ...CALL, intent_id: '' },
        { ...CALL, args: 'not an array' },
      ]) {
        expect(await wallet.call(bad)).toMatchObject({ ok: false, reason: 'error' });
      }
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe('read', () => {
    it('returns the result and sends no intent id', async () => {
      const { wallet } = walletWith(AGENT_POLICY);
      expect(
        await wallet.read({ contract: 'converter', function: 'quote', args: [{ token: 'play' }] }),
      ).toEqual({ result: '40' });
      expect(fake.reads[0]).toEqual({
        contract: 'converter',
        function: 'quote',
        args: [{ token: 'play' }],
      });
      expect(fake.reads[0]).not.toHaveProperty('intentId');
    });

    it('surfaces a refusal by name', async () => {
      const { wallet } = walletWith(AGENT_POLICY);
      fake.readReply = { status: 403, body: { error: 'function_not_allowed', detail: 'quote is not readable' } };
      expect(await wallet.read({ contract: 'converter', function: 'quote', args: [] })).toEqual({
        error: 'function_not_allowed',
        detail: 'quote is not readable',
      });
    });

    it('records nothing, so a read is free to repeat', async () => {
      const { wallet, config } = walletWith(AGENT_POLICY);
      await wallet.read({ contract: 'converter', function: 'quote', args: [] });
      await wallet.read({ contract: 'converter', function: 'quote', args: [] });
      expect(fake.reads).toHaveLength(2);
      // THE LEDGER FILE IS NEVER EVEN CREATED. A stronger statement than "it
      // holds no intents", and the one that is actually true: a read reserves
      // nothing, so there is nothing to remember and no write to make.
      expect(existsSync(config.stateFile)).toBe(false);
    });
  });
});
