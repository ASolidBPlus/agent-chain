// wallet-mcp's behaviour, against a fake chain-svc. The fake records what it
// was asked, so the tests assert what was SENT as well as what came back - a
// double-spend that returned the right txHash would otherwise pass.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Wallet, refusalFor } from '../src/wallet.ts';
import type { WalletConfig } from '../src/config.ts';

const TOKEN = 'wallet-token-that-must-never-leak';
const AGENT = 'orch:shadowbroker';

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
    names: {
      'alpha.vee': { address: '0xaaa', canonical: 'alpha:darknetclient' },
      'treasury.vee': { address: '0xttt', canonical: 'treasury.vee' },
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
      if (url.pathname.startsWith('/reverse/')) return json(200, { canonical: AGENT, aliases: ['shadowbroker.vee'] });
      if (url.pathname.startsWith('/balance/')) return json(200, { vee: '250', eth: '1' });
      if (url.pathname.startsWith('/history/')) {
        return json(200, [
          { txHash: '0xh1', from: AGENT, to: 'alpha:darknetclient', vee: '50', blockNumber: '7', memo: 'stream job' },
          { txHash: '0xh2', from: 'alpha:darknetclient', to: AGENT, vee: '5', blockNumber: '6' },
        ]);
      }
      if (url.pathname.startsWith('/intents/')) {
        const id = decodeURIComponent(url.pathname.slice('/intents/'.length));
        state.intentQueries.push(id);
        const next =
          state.intentReplies.length > 1 ? state.intentReplies.shift()! : state.intentReplies[0];
        return next ? json(next.status, next.body) : json(404, { error: 'unknown_name' });
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

function walletWith(policy: Record<string, unknown> | null): { wallet: Wallet; config: WalletConfig } {
  const policyFile = join(dir, 'policy.json');
  if (policy) writeFileSync(policyFile, JSON.stringify(policy));
  const config: WalletConfig = {
    agentId: AGENT,
    chainSvcUrl: fake.url,
    walletToken: TOKEN,
    policyFile,
    stateFile: join(dir, 'state.json'),
  };
  return { wallet: new Wallet(config), config };
}

const AGENT_POLICY = {
  agentId: AGENT,
  max_per_tx: 100,
  max_per_stage: 500,
  allow: ['*.vee'],
  deny: ['treasury.vee'],
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
    expect(await wallet.send({ to: 'alpha.vee', vee: '50', intent_id: 'a1', memo: 'stream job' })).toEqual({
      ok: true,
      txHash: '0xtx1',
    });
    expect(fake.transfers).toHaveLength(1);
    expect(fake.transfers[0]).toMatchObject({ to: 'alpha.vee', vee: '50', intentId: 'a1', memo: 'stream job' });
  });

  // Criterion 4: the same call again returns the SAME txHash and the money
  // moves once. Asserting the txHash alone would pass even if it sent twice,
  // so the fake's record of what it received is the real assertion.
  it('replays an identical intent without sending again', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const first = await wallet.send({ to: 'alpha.vee', vee: '50', intent_id: 'a1' });
    const second = await wallet.send({ to: 'alpha.vee', vee: '50', intent_id: 'a1' });

    expect(second).toEqual(first);
    expect(fake.transfers).toHaveLength(1);
  });

  // Reusing an intent id for a DIFFERENT payment is the mistake the reason
  // exists to name - and it must not silently send.
  it('refuses an intent id reused for a different payment', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    await wallet.send({ to: 'alpha.vee', vee: '50', intent_id: 'a1' });
    const result = await wallet.send({ to: 'alpha.vee', vee: '75', intent_id: 'a1' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('duplicate_intent');
    expect(fake.transfers).toHaveLength(1);
  });

  it('survives a restart without forgetting an intent', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    await wallet.send({ to: 'alpha.vee', vee: '50', intent_id: 'a1' });

    const { wallet: reborn } = walletWith(AGENT_POLICY); // fresh process, same state file
    expect(await reborn.send({ to: 'alpha.vee', vee: '50', intent_id: 'a1' })).toEqual({ ok: true, txHash: '0xtx1' });
    expect(fake.transfers).toHaveLength(1);
  });

  it('refuses over max_per_tx locally, without troubling chain-svc', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const result = await wallet.send({ to: 'alpha.vee', vee: '150', intent_id: 'b1' });

    expect(result).toMatchObject({ ok: false, reason: 'over_max_per_tx' });
    expect(fake.transfers).toHaveLength(0);
  });

  it('refuses a denied counterparty', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.send({ to: 'treasury.vee', vee: '1', intent_id: 'c1' })).toMatchObject({
      ok: false,
      reason: 'counterparty_denied',
    });
    expect(fake.transfers).toHaveLength(0);
  });

  // Criterion 9's shape at the tool: a bare local id is not a registered name.
  it('refuses an unknown name and a bare local id', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.send({ to: 'nobody.vee', vee: '1', intent_id: 'd1' })).toMatchObject({
      ok: false,
      reason: 'unknown_name',
    });
    expect(await wallet.send({ to: 'darknetclient', vee: '1', intent_id: 'd2' })).toMatchObject({
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
    const result = await wallet.send({ to: 'ghost', vee: '1', intent_id: 'd3' });
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
    const result = await wallet.send({ to: 'toby', vee: '1', intent_id: 'd4' });
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
    expect(await wallet.send({ to: 'alpha.vee', vee: '1', intent_id: 'r1' })).toMatchObject({
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
    const result = await wallet.send({ to: 'alpha.vee', vee: '1', intent_id: 'r2' });
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

  it('refuses when the policy file says frozen', async () => {
    const { wallet } = walletWith({ ...AGENT_POLICY, frozen: true });
    expect(await wallet.send({ to: 'alpha.vee', vee: '1', intent_id: 'e1' })).toMatchObject({
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

    expect(await wallet.send({ to: 'alpha.vee', vee: '100', intent_id: 'f1' })).toMatchObject({
      ok: false,
      reason: 'over_stage_cap',
    });
  });

  // A refused send must stay retryable: nothing is recorded, so the same intent
  // id can be used again once the cap resets.
  it('does not record a refused send', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'over_stage_cap' } };
    await wallet.send({ to: 'alpha.vee', vee: '100', intent_id: 'g1' });

    fake.reply = { status: 200, body: { txHash: '0xlater' } };
    expect(await wallet.send({ to: 'alpha.vee', vee: '100', intent_id: 'g1' })).toEqual({ ok: true, txHash: '0xlater' });
  });

  // An unmapped chain-svc code must NOT become a plausible-looking refusal:
  // telling a persona "counterparty_denied" when the truth was a 502 teaches it
  // something false about the game.
  it('does not dress an unexpected failure up as a policy refusal', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 502, body: { error: 'chain_error', detail: 'reverted' } };

    const result = await wallet.send({ to: 'alpha.vee', vee: '1', intent_id: 'h1' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('error');
  });

  it('sends the wallet-mcp marker so chain-svc can tag the spend', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    await wallet.send({ to: 'alpha.vee', vee: '1', intent_id: 'i1' });
    expect(fake.headers[0]!['x-wallet-client']).toMatch(/^wallet-mcp\//);
  });
});

describe('reads', () => {
  it('reports who it is, with its aliases', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.whoami()).toEqual({ agentId: AGENT, address: '0xme', aliases: ['shadowbroker.vee'] });
  });

  it('labels history by direction and names the counterparty', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const entries = (await wallet.history()) as Array<Record<string, unknown>>;

    expect(entries[0]).toMatchObject({ direction: 'out', counterparty: 'alpha:darknetclient', vee: '50' });
    expect(entries[1]).toMatchObject({ direction: 'in', counterparty: 'alpha:darknetclient', vee: '5' });
  });

  it('resolves a name to an address and a canonical id', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    expect(await wallet.resolve('alpha.vee')).toEqual({ address: '0xaaa', canonical: 'alpha:darknetclient' });
    expect(await wallet.resolve('nobody.vee')).toMatchObject({ error: expect.any(String) });
  });
});

// Spec S5 secret hygiene, tested rather than asserted. mesh-agent's transcript
// redactor does NOT cover WALLET_TOKEN, so anything this returns is written to
// the on-disk transcript in plaintext and streamed to the arena god-feed.
describe('the wallet token never reaches the model', () => {
  it('appears in no tool result or error, on any path', async () => {
    const { wallet } = walletWith(AGENT_POLICY);

    const outputs: unknown[] = [
      await wallet.whoami(),
      await wallet.balance(),
      await wallet.resolve('alpha.vee'),
      await wallet.resolve('nobody.vee'),
      await wallet.history(),
      await wallet.send({ to: 'alpha.vee', vee: '50', intent_id: 'z1' }),
      await wallet.send({ to: 'alpha.vee', vee: '150', intent_id: 'z2' }),
      await wallet.send({ to: 'nobody.vee', vee: '1', intent_id: 'z3' }),
      await wallet.send({ to: 'treasury.vee', vee: '1', intent_id: 'z4' }),
      await wallet.send({ to: '', vee: '1', intent_id: 'z5' }),
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

    const result = await wallet.send({ to: 'alpha.vee', vee: '1', intent_id: 'y1' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('keeps it out of the state file on disk', async () => {
    const { wallet, config } = walletWith(AGENT_POLICY);
    await wallet.send({ to: 'alpha.vee', vee: '50', intent_id: 'x1' });
    expect(readFileSync(config.stateFile, 'utf8')).not.toContain(TOKEN);
  });
});

// Spec S5, ruled 01:15 UTC. The model must never see the broadcast-to-record
// window, because the obvious action on it - send again - is the double charge.
describe('reconciling an unresolved intent', () => {
  const send = { to: 'alpha.vee', vee: '10', intent_id: 'i-recon' };

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

  it('reports a reverted transfer as no VEE moved, not as unresolved', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'intent_unresolved' } };
    fake.intentReplies = [{ status: 200, body: { status: 'failed', txHash: '0xrevert' } }];

    const res = await wallet.send(send);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('no VEE moved');
    expect(fake.transfers).toHaveLength(1);
  }, 15_000);


  // The one case the model DOES see. It gets the instruction that matters -
  // retry the same id - rather than a bare failure it would answer by re-sending.
  it('surfaces intent_unresolved when it never settles, and still sends only once', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    fake.reply = { status: 409, body: { error: 'intent_unresolved' } };
    fake.intentReplies = [{ status: 200, body: { status: 'reserved' } }];

    const res = await wallet.send({ to: 'alpha.vee', vee: '10', intent_id: 'i-never' });

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
    });
  }

  it('surfaces the transport failure instead of flattening to unknown_name', async () => {
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(AGENT_POLICY));
    const res = await offlineWallet().send({ to: 'alpha.vee', vee: '10', intent_id: 'off-1' });

    expect(res.ok).toBe(false);
    // THE POINT: not unknown_name. A student debugging this must not be sent
    // looking for a registration bug that does not exist.
    expect(res.reason).not.toBe('unknown_name');
    expect(res.detail).toContain('unreachable');
  });

  it('still reports a genuinely unregistered name as unknown_name', async () => {
    const { wallet } = walletWith(AGENT_POLICY);
    const res = await wallet.send({ to: 'nobody.vee', vee: '10', intent_id: 'off-2' });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown_name');
  });

  // The two must be DISTINGUISHABLE, which is the property that was broken:
  // previously both produced byte-identical results.
  it('gives the two cases different answers', async () => {
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(AGENT_POLICY));
    const outage = await offlineWallet().send({ to: 'alpha.vee', vee: '10', intent_id: 'off-3' });
    const { wallet } = walletWith(AGENT_POLICY);
    const missing = await wallet.send({ to: 'nobody.vee', vee: '10', intent_id: 'off-4' });

    expect(JSON.stringify(outage)).not.toBe(JSON.stringify(missing));
  });
});
