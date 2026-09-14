// Routing and auth, exercised through a real listening server rather than by
// calling handlers directly - the bug that matters lives in the wiring (does an
// unauthenticated request actually get refused?), not in the handler.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'node:http';
import { createChainSvcServer, type Services } from '../src/server.ts';
import { authenticate, hashToken } from '../src/auth.ts';
import { Store } from '../src/store.ts';
import { HttpError } from '../src/errors.ts';

const TOKEN = 'correct-horse-battery-staple';
const WALLET_TOKEN = 'a-wallet-credential';
const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// A real store, so the credential lookup under test is the real one rather
// than a stub that agrees with whatever the code does.
const store = new Store(':memory:');
store.setWalletTokenHash('alpha:client', hashToken(WALLET_TOKEN));

let server: Server;
let base: string;

// Enough of the services graph to reach routing and validation. Any handler
// that needs the chain is covered by the integration suite instead, which runs
// against a real Anvil - a mocked chain would only prove the mock works.
const services = {
  config: { token: TOKEN },
  store,
  // The module view the router and /health read. A vee-plus-names deployment,
  // which is what every expectation in this file was written against.
  chain: {
    deployment: { chainId: 31337, treasury: '0xtreasury' },
    modules: {
      tokens: [{ key: 'vee', address: '0xvee', symbol: 'VEE', decimals: 18 }],
      names: { address: '0xreg', tld: 'vee' },
    },
  },
  resolver: {
    lookup: async (name: string) => (name === 'alpha.vee' ? { address: WALLET, canonical: 'alpha:client' } : null),
    require: async (name: string) => {
      if (name !== 'alpha.vee') throw new HttpError('unknown_name', `no registry entry for ${name}`);
      return { address: WALLET, canonical: 'alpha:client' };
    },
    reverseOf: async () => 'alpha:client',
    aliasesOf: async () => ['alpha.vee'],
  },
} as unknown as Services;

beforeAll(async () => {
  server = createChainSvcServer(services);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

const auth = { authorization: `Bearer ${TOKEN}` };

/// res.json() is `unknown`; these tests assert on the error envelope's shape.
async function body(res: Response): Promise<{ error?: string }> {
  return (await res.json()) as { error?: string };
}

describe('authentication', () => {
  it('refuses a request with no Authorization header', async () => {
    const res = await fetch(`${base}/supply`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('refuses a wrong token, and one that is a prefix of the right one', async () => {
    for (const token of ['nope', TOKEN.slice(0, -1), `${TOKEN}x`, '']) {
      const res = await fetch(`${base}/supply`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
    }
  });

  it('refuses a token sent without the Bearer scheme', async () => {
    const res = await fetch(`${base}/supply`, { headers: { authorization: TOKEN } });
    expect(res.status).toBe(401);
  });

  // The healthcheck runs from Compose, which has no token.
  it('serves /health unauthenticated', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    // The module list is part of /health so an operator can see what a
    // deployment actually has without a credential. Sorted, so two deployments
    // with the same modules compare equal whatever order the manifest used.
    expect(await res.json()).toEqual({ ok: true, modules: ['names', 'token:vee'] });
  });

  it('compares tokens without leaking length through an exception', () => {
    expect(authenticate(`Bearer ${TOKEN}`, TOKEN, store)).toEqual({ scope: 'platform' });
    expect(() => authenticate('Bearer short', TOKEN, store)).toThrow(HttpError);
    expect(() => authenticate(undefined, TOKEN, store)).toThrow(HttpError);
  });

  it('recognises a wallet credential as its own principal', () => {
    expect(authenticate(`Bearer ${WALLET_TOKEN}`, TOKEN, store)).toEqual({
      scope: 'wallet',
      agentId: 'alpha:client',
    });
  });
});

// Criterion 11, at the routing layer. The exploit these close was demonstrated
// live before they existed: one shared token let any persona sign from any
// wallet and mint itself an org-class wallet from the treasury.
describe('credential scopes', () => {
  const wallet = { authorization: `Bearer ${WALLET_TOKEN}` };

  it('refuses POST /wallets under a wallet credential', async () => {
    const res = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { ...wallet, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'orch:selfminted', fundVee: 9999, kind: 'org' }),
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe('wrong_scope');
  });

  it('refuses /sign-transfer under the platform credential - it has no wallet identity', async () => {
    const res = await fetch(`${base}/sign-transfer`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'alpha.vee', vee: 1 }),
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe('wrong_scope');
  });

  it('lets a wallet read itself and refuses another wallet', async () => {
    const mine = await fetch(`${base}/balance/alpha.vee`, { headers: wallet });
    // Reaches the handler, which then needs a chain the stub does not provide -
    // the point is that authorisation did not refuse it.
    expect(mine.status).not.toBe(403);

    const theirs = await fetch(`${base}/history/${encodeURIComponent('orch:someone-else')}`, { headers: wallet });
    expect(theirs.status).toBe(404); // unknown name resolves first
  });

  it('refuses /supply under a wallet credential', async () => {
    const res = await fetch(`${base}/supply`, { headers: wallet });
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe('wrong_scope');
  });
});

describe('GET /wallets/:agentId', () => {
  // PLATFORM SCOPE, deliberately not 'any'. The row carries the bare-id
  // counter, which is a facilitator's measurement OF the persona - a wallet
  // reading its own detector score is the observed party reading the
  // observer's notes.
  it('refuses a wallet-scope caller', async () => {
    const res = await fetch(`${base}/wallets/${encodeURIComponent('orch:a')}`, {
      headers: { authorization: `Bearer ${WALLET_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns the row a write path produced and nothing could read', async () => {
    store.markSpawned('orch:rowtest', WALLET, 'burner');
    const res = await fetch(`${base}/wallets/${encodeURIComponent('orch:rowtest')}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agentId: 'orch:rowtest',
      address: WALLET,
      canonical: 'alpha:client',
      kind: 'burner',
      frozen: false,
      bareIdCount: 0,
    });
  });

  // NULL TRAVELS AS NULL to the consumer. Filling it in downstream would undo
  // the column's only purpose just as surely as backfilling the table would.
  it('carries an unrecorded kind through as null', async () => {
    store.markSpawned('orch:oldrow', WALLET, null);
    const res = await fetch(`${base}/wallets/${encodeURIComponent('orch:oldrow')}`, { headers: auth });
    expect((await res.json() as { kind: unknown }).kind).toBeNull();
  });

  it('404s a wallet that was never spawned', async () => {
    const res = await fetch(`${base}/wallets/${encodeURIComponent('orch:never')}`, { headers: auth });
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe('unknown_name');
  });
});

describe('routing', () => {
  it('resolves a percent-encoded canonical id', async () => {
    const res = await fetch(`${base}/resolve/${encodeURIComponent('alpha.vee')}`, { headers: auth });
    expect(res.status).toBe(200);
    // `resolvedVia` on every answer, platform scope included (§5). Constant
    // there rather than absent: a caller should not have to know which scope it
    // used to know whether the field means anything.
    expect(await res.json()).toEqual({
      address: WALLET, canonical: 'alpha:client', resolvedVia: 'exact',
    });
  });

  // Criterion 9's shape: a bare local id is syntactically fine, so it reaches
  // the registry and comes back unknown_name rather than being rejected early.
  it('reports a bare local id as unknown_name', async () => {
    const res = await fetch(`${base}/resolve/client`, { headers: auth });
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe('unknown_name');
  });

  it('rejects a two-colon origin string as invalid_name', async () => {
    const res = await fetch(`${base}/resolve/${encodeURIComponent('orch:pod1:alice')}`, { headers: auth });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('invalid_name');
  });

  it('rejects a non-address on /reverse', async () => {
    const res = await fetch(`${base}/reverse/not-an-address`, { headers: auth });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('invalid_request');
  });

  it('returns the canonical name and aliases for an address', async () => {
    const res = await fetch(`${base}/reverse/${WALLET}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canonical: 'alpha:client', aliases: ['alpha.vee'] });
  });

  it('404s an unknown route as invalid_request, not as a crash', async () => {
    const res = await fetch(`${base}/nope`, { headers: auth });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('invalid_request');
  });

  // /resolve/a/b is not a name that happens to contain a slash.
  it('does not treat a multi-segment path as a name', async () => {
    const res = await fetch(`${base}/resolve/alpha/vee`, { headers: auth });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('invalid_request');
  });

  // A malformed escape is a CALLER error. Unwrapped, decodeURIComponent throws
  // URIError, which reached the internal_error path and wrote to the log line
  // reserved for "this is a bug in chain-svc" - letting any token holder
  // degrade the signal an operator uses to find real bugs.
  it('reports a malformed percent-escape as a caller error, not a service bug', async () => {
    const res = await fetch(`${base}/resolve/%`, { headers: auth });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('invalid_request');
  });

  // The one-segment check used to run on the ENCODED path, so %2F survived it
  // and became a slash afterwards. Safe then only because every consumer
  // re-validates the charset; now the decode happens first, so the check sees
  // what the handler will see.
  it('rejects an encoded separator rather than passing it through', async () => {
    const res = await fetch(`${base}/resolve/%2Fetc%2Fpasswd`, { headers: auth });
    expect(res.status).toBe(400);
  });
});

// ruled, after the registry finding: `register` is permissionless
// with an arbitrary target, so anyone can make a name resolve to someone else's
// wallet. The contract refuses to make such a name anyone's PRIMARY, but it
// still resolves - so /reverse must not report it as that wallet's alias either.
describe('the alias index', () => {
  it('lists only names the wallet owns AND points at itself', async () => {
    const { Resolver } = await import('../src/resolver.ts');

    const registered = [
      { args: { name: 'mine.vee', owner: WALLET, target: WALLET } },
      { args: { name: 'orch:me', owner: WALLET, target: WALLET } },
      { args: { name: 'strangers-label.vee', owner: '0xbad', target: WALLET } },
      { args: { name: 'elsewhere.vee', owner: WALLET, target: '0xother' } },
    ];

    const chain = {
      deployment: { NameRegistry: '0xreg' },
      modules: { tokens: [], names: { address: '0xreg', tld: 'vee' } },
      publicClient: {
        getContractEvents: async () => registered,
        readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
          if (functionName === 'reverseOf') return 'orch:me';
          // resolve(): every name in the fixture still points where it did.
          const entry = registered.find((r) => r.args.name === (args as string[])[0]);
          return entry ? entry.args.target : '0x0000000000000000000000000000000000000000';
        },
      },
    } as unknown as import('../src/chain.ts').Chain;

    const aliases = await new Resolver(chain, store).aliasesOf(WALLET);

    expect(aliases).toEqual(['mine.vee']);
    expect(aliases).not.toContain('strangers-label.vee'); // owned by someone else
    expect(aliases).not.toContain('orch:me'); // the canonical, not an alias
    expect(aliases).not.toContain('elsewhere.vee'); // points at another wallet
  });
});

// ruled. GET /intents/:id must not become an existence oracle: if
// somebody else's real intent answered differently from a made-up one, guessing
// ids would confirm another wallet's activity.
describe('an intent is not an existence oracle', () => {
  const walletAuth = { authorization: `Bearer ${WALLET_TOKEN}` };

  beforeAll(() => {
    // A real reservation owned by a DIFFERENT wallet.
    store.reserve({
      intentId: 'belongs-to-beta',
      agentId: 'beta:someoneelse',
      stage: store.currentStage(),
      amount: 1n,
      capWei: 10n ** 21n,
    });
  });

  it("answers another wallet's real intent exactly as it answers a random one", async () => {
    const real = await fetch(`${base}/intents/belongs-to-beta`, { headers: walletAuth });
    const fake = await fetch(`${base}/intents/no-such-intent-at-all`, { headers: walletAuth });

    const realText = await real.text();
    const fakeText = await fake.text();

    expect(real.status).toBe(404);
    expect(fake.status).toBe(404);
    // Byte-identical once the echoed id is normalised, not merely both-404: a
    // differing detail string is the leak.
    expect(realText).toBe(fakeText.replace('no-such-intent-at-all', 'belongs-to-beta'));
    expect((JSON.parse(realText) as { error?: string }).error).toBe('unknown_intent');
  });

  it('lets the owning wallet read its own', async () => {
    store.reserve({
      intentId: 'mine-alpha',
      agentId: 'alpha:client',
      stage: store.currentStage(),
      amount: 1n,
      capWei: 10n ** 21n,
    });
    const res = await fetch(`${base}/intents/mine-alpha`, { headers: walletAuth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ intentId: 'mine-alpha', status: 'reserved' });
  });

  it('lets platform scope read any', async () => {
    const res = await fetch(`${base}/intents/belongs-to-beta`, { headers: auth });
    expect(res.status).toBe(200);
  });
});
