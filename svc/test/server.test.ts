// Routing and auth, exercised through a real listening server rather than by
// calling handlers directly - the bug that matters lives in the wiring (does an
// unauthenticated request actually get refused?), not in the handler.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'node:http';
import { createChainSvcServer, type Services } from '../src/server.ts';
import { assertAuthorized } from '../src/config.ts';
import { HttpError } from '../src/errors.ts';

const TOKEN = 'correct-horse-battery-staple';
const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

let server: Server;
let base: string;

// Enough of the services graph to reach routing and validation. Any handler
// that needs the chain is covered by the integration suite instead, which runs
// against a real Anvil - a mocked chain would only prove the mock works.
const services = {
  config: { token: TOKEN },
  resolver: {
    lookup: async (name: string) => (name === 'alpha.vee' ? { address: WALLET, canonical: 'alpha:darknetclient' } : null),
    require: async (name: string) => {
      if (name !== 'alpha.vee') throw new HttpError('unknown_name', `no registry entry for ${name}`);
      return { address: WALLET, canonical: 'alpha:darknetclient' };
    },
    reverseOf: async () => 'alpha:darknetclient',
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
    expect(await res.json()).toEqual({ ok: true });
  });

  it('compares tokens without leaking length through an exception', () => {
    expect(() => assertAuthorized(`Bearer ${TOKEN}`, TOKEN)).not.toThrow();
    expect(() => assertAuthorized('Bearer short', TOKEN)).toThrow(HttpError);
    expect(() => assertAuthorized(undefined, TOKEN)).toThrow(HttpError);
  });
});

describe('routing', () => {
  it('resolves a percent-encoded canonical id', async () => {
    const res = await fetch(`${base}/resolve/${encodeURIComponent('alpha.vee')}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ address: WALLET, canonical: 'alpha:darknetclient' });
  });

  // Criterion 9's shape: a bare local id is syntactically fine, so it reaches
  // the registry and comes back unknown_name rather than being rejected early.
  it('reports a bare local id as unknown_name', async () => {
    const res = await fetch(`${base}/resolve/darknetclient`, { headers: auth });
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
    expect(await res.json()).toEqual({ canonical: 'alpha:darknetclient', aliases: ['alpha.vee'] });
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

// Ruled 22:12 UTC, after the registry finding: `register` is permissionless
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

    const aliases = await new Resolver(chain).aliasesOf(WALLET);

    expect(aliases).toEqual(['mine.vee']);
    expect(aliases).not.toContain('strangers-label.vee'); // owned by someone else
    expect(aliases).not.toContain('orch:me'); // the canonical, not an alias
    expect(aliases).not.toContain('elsewhere.vee'); // points at another wallet
  });
});
