// Validation paths of spawn and transfer, which run BEFORE any chain call - so
// the stubs below are never reached, and a test that starts touching them is
// telling you an argument check moved after a side effect.

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Spawner } from '../src/spawn.ts';
import { loadPolicyDefaults } from '../src/policy.ts';
import { Treasury, type Signer } from '../src/treasury.ts';
import { Store } from '../src/store.ts';
import { HttpError } from '../src/errors.ts';
import type { Config } from '../src/config.ts';
import type { Chain } from '../src/chain.ts';
import type { Keystore } from '../src/keystore.ts';
import type { Resolver } from '../src/resolver.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = loadPolicyDefaults(join(PKG, 'policy-defaults.json'));

const config = {
  policyDir: '/tmp/does-not-exist',
  rpcUrl: 'http://chain:8545',
  policyDefaultsPath: join(PKG, 'policy-defaults.json'),
} as Config;

function exploding(what: string) {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`${what} must not be reached: validation should have refused this first`);
      },
    },
  );
}

function spawner(store = new Store(':memory:')): { spawner: Spawner; store: Store } {
  return {
    spawner: new Spawner(
      config,
      exploding('chain') as Chain,
      exploding('keystore') as Keystore,
      store,
      exploding('resolver') as Resolver,
      DEFAULTS,
    ),
    store,
  };
}

function treasury(store = new Store(':memory:')): Treasury {
  return new Treasury(
    config,
    exploding('chain') as Chain,
    exploding('keystore') as Keystore,
    store,
    exploding('resolver') as Resolver,
    DEFAULTS,
  );
}

/// The credential a wallet presents. Signing derives the source from THIS, not
/// from the request body.
const asWallet = (agentId: string) => ({ scope: 'wallet', agentId }) as const;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : `not-an-HttpError: ${String(err)}`;
  }
  return 'no-error';
}

describe('POST /wallets validation', () => {
  it('refuses a bare local id, a two-colon relay string and uppercase', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'darknetclient' }))).toBe('invalid_agent_id');
    expect(await codeOf(() => s.spawn({ agentId: 'orch:pod1:alice' }))).toBe('invalid_agent_id');
    expect(await codeOf(() => s.spawn({ agentId: 'orch:ShadowBroker' }))).toBe('invalid_agent_id');
  });

  // A burner is deliberately an unnamed address the game must trace, so a named
  // burner is a contradiction rather than a request to be helpful about.
  it('refuses a burner with an alias', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:ghost', kind: 'burner', alias: 'ghost.vee' }))).toBe(
      'invalid_request',
    );
  });

  it('refuses an unknown kind', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', kind: 'wizard' }))).toBe('invalid_request');
  });

  it('refuses an alias containing a colon, which could impersonate a canonical id', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', alias: 'orch:fake' }))).toBe('invalid_name');
  });

  it('refuses a fundVee with more than 18 decimal places', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', fundVee: '1.0000000000000000001' }))).toBe(
      'invalid_amount',
    );
  });

  // The idempotency marker is the ONLY thing that short-circuits a spawn. A key
  // file alone is not proof: a process that died between writing the key and
  // funding the wallet would otherwise report success for an empty wallet.
  it('returns the recorded wallet without touching the chain once spawned', async () => {
    const store = new Store(':memory:');
    const { spawner: s } = spawner(store);
    store.markSpawned('orch:shadowbroker', '0x1111111111111111111111111111111111111111');

    const result = await s.spawn({ agentId: 'orch:shadowbroker', fundVee: 250, kind: 'agent' });
    expect(result.address).toBe('0x1111111111111111111111111111111111111111');
    store.close();
  });
});

// The crash-recovery path, and the ONLY thing that isolates the anti-double-fund
// guard inside fundVee().
//
// Found by mutation: deleting `if (balance >= amount) return;` changed nothing
// in the integration run, because the spawn marker short-circuits a repeat
// spawn long before funding is reached. Two guards, one scenario, so either
// could be deleted and everything stayed green - the same shape as the two
// assertPrivateChain guards in C2a.
//
// The scenario that reaches the inner guard is a spawn that DIED between
// funding the wallet and writing its marker. A retry then re-runs every step
// against a wallet that is already funded, and only the balance check stops it
// minting the seed a second time.
describe('a resumed spawn (marker missing, wallet already funded)', () => {
  it('does not send a second seed', async () => {
    const store = new Store(':memory:');
    const address = '0x2222222222222222222222222222222222222222';
    const seed = 250n * 10n ** 18n;
    const writes: string[] = [];

    const chain = {
      viemChain: { id: 31337 },
      deployment: { VEEBux: '0x3', NameRegistry: '0x4', treasury: '0x5', chainId: 31337 },
      publicClient: {
        getBalance: async () => 10n ** 18n, // already endowed with its 1 ETH
        readContract: async () => seed, // already holds the full seed
        waitForTransactionReceipt: async () => ({}),
      },
      walletClient: {
        account: { address: '0x5' },
        sendTransaction: async () => {
          writes.push('sendTransaction');
          return '0xdead';
        },
        writeContract: async () => {
          writes.push('writeContract');
          return '0xbeef';
        },
      },
    } as unknown as Chain;

    const keystore = {
      has: async () => true,
      load: async () => ({ address, privateKey: '0x00' }),
    } as unknown as Keystore;

    const resolver = {
      // Both names already registered to this wallet by the attempt that died.
      lookup: async () => ({ address, canonical: 'orch:shadowbroker' }),
    } as unknown as Resolver;

    const s = new Spawner(
      { ...config, policyDir: mkdtempSync(join(tmpdir(), 'policies-')) } as Config,
      chain,
      keystore,
      store,
      resolver,
      DEFAULTS,
    );

    const result = await s.spawn({ agentId: 'orch:shadowbroker', fundVee: 250, kind: 'agent', alias: 'sb.vee' });

    expect(result.address).toBe(address);
    expect(writes).toEqual([]); // no ETH, no VEE, no registration - nothing to redo
    expect(store.spawnedAddress('orch:shadowbroker')).toBe(address);
    store.close();
  });
});

describe('POST /sign-transfer validation', () => {
  it('refuses a frozen wallet before loading its key', async () => {
    const store = new Store(':memory:');
    store.freeze('orch:scammer');
    const t = treasury(store);

    expect(
      await codeOf(() => t.signTransfer(asWallet('orch:scammer'), { to: 'alpha.vee', vee: 1 })),
    ).toBe('wallet_frozen');
    store.close();
  });

  it('refuses a two-colon destination', async () => {
    const t = treasury();
    expect(
      await codeOf(() => t.signTransfer(asWallet('orch:a'), { to: 'orch:pod1:alice', vee: 1 })),
    ).toBe('invalid_name');
  });

  // The rule that closes the drain: the source comes from the credential, and a
  // body field that disagrees is refused rather than silently overridden.
  it('refuses a body fromAgentId naming another wallet', async () => {
    const t = treasury();
    expect(
      await codeOf(() =>
        t.signTransfer(asWallet('orch:persona'), { fromAgentId: 'orch:victim', to: 'alpha.vee', vee: 1 }),
      ),
    ).toBe('principal_mismatch');
  });

  it('refuses the platform credential outright - it has no wallet identity', async () => {
    const t = treasury();
    expect(
      await codeOf(() => t.signTransfer({ scope: 'platform' }, { to: 'alpha.vee', vee: 1 })),
    ).toBe('wrong_scope');
  });
});


// The caps are game balance the owner tunes (ledger D8), so they live in
// policy-defaults.json and NOT in a constant here. These tests assert the
// wiring - that the right entry is picked and a caller can override it - and
// deliberately do not assert the numbers, which are powerout-planner's to move
// without breaking a build.
describe('policy defaults', () => {
  it('has an entry for every wallet kind', () => {
    for (const kind of ['org', 'agent', 'burner'] as const) {
      expect(DEFAULTS[kind].max_per_tx).toBeGreaterThan(0);
      expect(DEFAULTS[kind].max_per_stage).toBeGreaterThanOrEqual(DEFAULTS[kind].max_per_tx);
      expect(DEFAULTS[kind].deny).toContain('treasury.vee');
    }
  });

  // A missing or malformed file must stop the service rather than quietly
  // producing a wallet with no caps at all.
  it('refuses to load a missing or malformed defaults file', () => {
    expect(() => loadPolicyDefaults('/nope/policy-defaults.json')).toThrow(/cannot read policy defaults/);

    const bad = join(mkdtempSync(join(tmpdir(), 'policy-')), 'p.json');
    writeFileSync(bad, JSON.stringify({ org: {}, agent: {}, burner: {} }));
    expect(() => loadPolicyDefaults(bad)).toThrow(/no valid/);

    const negative = join(mkdtempSync(join(tmpdir(), 'policy-')), 'p.json');
    writeFileSync(
      negative,
      JSON.stringify({
        org: DEFAULTS.org,
        agent: { ...DEFAULTS.agent, max_per_tx: -1 },
        burner: DEFAULTS.burner,
      }),
    );
    expect(() => loadPolicyDefaults(negative)).toThrow(/no valid "agent"/);
  });

  it('rejects a caller-supplied policy of the wrong shape', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', policy: { max_per_tx: 0 } }))).toBe('invalid_request');
    expect(
      await codeOf(() => s.spawn({ agentId: 'orch:x', policy: { ...DEFAULTS.agent, allow: [1] } })),
    ).toBe('invalid_request');
  });
});

// THE RELEASE RULE, tested where it can actually go wrong. The store tests
// prove the reservation is atomic; these prove signTransfer does not hand it
// back after the money may already have moved.
describe('the release rule', () => {
  const args = { agentId: 'orch:a', stage: 's1', amount: 10n ** 18n, capWei: 10n ** 21n };

  // A send whose broadcast throws is INDISTINGUISHABLE from one that landed and
  // whose response was lost. Releasing here would re-authorise a transfer that
  // may already have happened - which is the double-charge, arriving by way of
  // the caller's entirely correct retry.
  it('keeps the reservation when the broadcast fails', async () => {
    const store = new Store(':memory:');
    const t = treasury(store);
    store.reserve({ intentId: 'i1', ...args });

    const wallet = {
      sendRawTransaction: () => Promise.reject(new Error('socket hang up')),
    };
    await expect(
      (t as unknown as { broadcast: (a: unknown) => Promise<unknown> }).broadcast({
        wallet,
        serializedTransaction: '0xdead',
        intentId: 'i1',
        fromAgentId: 'orch:a',
        memo: null,
      }),
    ).rejects.toThrow();

    expect(store.spentThisStage('orch:a', 's1')).toBe(args.amount);
    expect(store.reserve({ intentId: 'i1', ...args })).toEqual({ outcome: 'duplicate', txHash: null });
    store.close();
  });

  // The crash window. If the hash is recorded only after the receipt, a process
  // that dies while waiting leaves an intent reserved with no hash - and the
  // retry gets `intent_unresolved` for a send that in fact completed, which is
  // an operator ticket for every dropped connection.
  it('records the hash as soon as the send returns one, before the receipt', async () => {
    const store = new Store(':memory:');
    const t = treasury(store);
    store.reserve({ intentId: 'i2', ...args });

    // `chain` is the exploding proxy, so touching publicClient IS the failure
    // between the send and the receipt.
    await expect(
      (t as unknown as { broadcast: (a: unknown) => Promise<unknown> }).broadcast({
        wallet: { sendRawTransaction: () => Promise.resolve('0xfeed') },
        serializedTransaction: '0xdead',
        intentId: 'i2',
        fromAgentId: 'orch:a',
        memo: null,
      }),
    ).rejects.toThrow();

    expect(store.intentTxHash('i2')).toBe('0xfeed');
    store.close();
  });

  // signTransfer's two answers to a replay. Neither may reach the chain: one
  // returns the original result, the other refuses for reconciliation. The
  // chain stub explodes on any access, so reaching it fails the test.
  describe('a replayed intent never reaches the chain', () => {
    const replayTreasury = (store: Store) =>
      new Treasury(
        config,
        exploding('chain') as Chain,
        { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
        store,
        { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD' }) } as unknown as Resolver,
        DEFAULTS,
      );
    // NOT treasury.vee: that is on the default deny list, so the policy check
    // refuses first and the replay path is never reached - which is the correct
    // ordering, and made this fixture test the wrong thing until it was fixed.
    const send = { fromAgentId: 'orch:a', to: 'bob.vee', vee: '1', intentId: 'replay' };
    const seed = (store: Store) => {
      const stage = store.currentStage();
      store.reserve({ intentId: 'replay', agentId: 'orch:a', stage, amount: 10n ** 18n, capWei: 10n ** 21n });
    };

    it('returns the ORIGINAL hash when the first send completed', async () => {
      const store = new Store(':memory:');
      seed(store);
      store.completeIntent('replay', '0xorig');
      expect(await replayTreasury(store).signTransfer(asWallet('orch:a'), send)).toEqual({
        txHash: '0xorig',
        intentId: 'replay',
        intentIdSource: 'caller',
      });
      store.close();
    });

    it('refuses with intent_unresolved when the first send has no recorded hash', async () => {
      const store = new Store(':memory:');
      seed(store);
      expect(await codeOf(() => replayTreasury(store).signTransfer(asWallet('orch:a'), send))).toBe(
        'intent_unresolved',
      );
      store.close();
    });
  });

  // Structural, and deliberately so: build-triage's warning was that a SECOND
  // catch reasoning about release is the tell. A behavioural test cannot see a
  // release path that has not been written yet, so this asserts the shape - one
  // call, in the pre-broadcast branch.
  it('has exactly one release call in the whole of treasury.ts', async () => {
    const src = await Bun.file(join(PKG, 'src/treasury.ts')).text();
    expect(src.match(/\.release\(/g) ?? []).toHaveLength(1);
    // ...and it is not in the tail that runs after the transaction is on the wire.
    expect(src.slice(src.indexOf('AT OR AFTER THE BROADCAST'))).not.toContain('.release(');
  });
});

// A caller that forgets intentId loses idempotency. That is its choice to make,
// but it must be able to SEE that it made it - otherwise the first anyone knows
// is a double-charge nobody can explain.
describe('a missing intent id is visible, not silent', () => {
  const noIntent = new Treasury(
    config,
    exploding('chain') as Chain,
    { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
    new Store(':memory:'),
    { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD' }) } as unknown as Resolver,
    DEFAULTS,
  );

  it('warns, naming the generated id and what was lost', async () => {
    const said: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => void said.push(a.join(' '));
    try {
      await noIntent.signTransfer(asWallet('orch:a'), { to: 'bob.vee', vee: '1' }).catch(() => undefined);
    } finally {
      console.warn = real;
    }

    const warned = said.join('\n');
    expect(warned).toContain('no intentId');
    expect(warned).toContain('NOT deduplicated');
    expect(warned).toMatch(/chain-svc:[0-9a-f-]{36}/); // the id it generated, so it can be traced
  });

  it('says nothing when the caller did supply one', async () => {
    const said: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => void said.push(a.join(' '));
    try {
      await noIntent
        .signTransfer(asWallet('orch:a'), { to: 'bob.vee', vee: '1', intentId: 'mine' })
        .catch(() => undefined);
    } finally {
      console.warn = real;
    }
    expect(said.join('\n')).not.toContain('no intentId');
  });
});

// THE REGRESSION, PINNED WHERE IT HAPPENED. The store-level probe proves the
// reservation primitive is atomic - but the defect was never in the primitive,
// it was the ORDER in signTransfer. Measured: moving only the over_stage_cap
// check past the broadcast leaves the entire store-level suite green at 118/118
// while every concurrent send reaches the chain. This drives the whole of
// signTransfer and counts BROADCASTS, which is the thing the cap has to bound.
describe('concurrent signTransfer against a stage cap', () => {
  /// A Treasury whose signer is a counter. Nothing else is stubbed: the policy,
  /// the reservation, the ordering and the release rule are all the real ones.
  class CountingTreasury extends Treasury {
    broadcasts = 0;
    protected signerFor(): Signer {
      return {
        prepareTransactionRequest: async () => ({}),
        signTransaction: async () => '0xsigned' as const,
        sendRawTransaction: async () => {
          this.broadcasts++;
          return `0x${String(this.broadcasts).padStart(64, '0')}` as `0x${string}`;
        },
      };
    }
  }

  async function treasuryWithStageCap(veePerStage: number): Promise<CountingTreasury> {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({
        agentId: 'orch:a',
        max_per_tx: 100,
        max_per_stage: veePerStage,
        allow: ['*.vee'],
        deny: [],
        frozen: false,
      }),
    );
    return new CountingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: { VEEBux: '0x0' }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      new Store(':memory:'),
      { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD' }) } as unknown as Resolver,
      DEFAULTS,
    );
  }

  it('broadcasts exactly floor(cap/amount) of N concurrent sends', async () => {
    const t = await treasuryWithStageCap(100); // one 100-VEE send fits
    const send = (n: number) =>
      t.signTransfer(asWallet('orch:a'), { to: 'bob.vee', vee: '100', intentId: `i${n}` });

    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => send(n)));

    const ok = results.filter((r) => r.status === 'fulfilled');
    const capped = results.filter(
      (r) => r.status === 'rejected' && (r.reason as HttpError).code === 'over_stage_cap',
    );

    expect(ok).toHaveLength(1);
    expect(capped).toHaveLength(7);
    // The assertion the store-level test cannot make: seven sends never reached
    // the chain at all. If the cap moves after the broadcast this is 8.
    expect(t.broadcasts).toBe(1);
  }, 20_000);

  it('broadcasts five of ten when the cap is a multiple', async () => {
    const t = await treasuryWithStageCap(500);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, n) =>
        t.signTransfer(asWallet('orch:a'), { to: 'bob.vee', vee: '100', intentId: `j${n}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(t.broadcasts).toBe(5);
  }, 20_000);

  // The control: without it, a probe that always reports "1 broadcast" would
  // pass for the wrong reason.
  it('broadcasts a single sequential send that fits, so the probe can pass', async () => {
    const t = await treasuryWithStageCap(100);
    await t.signTransfer(asWallet('orch:a'), { to: 'bob.vee', vee: '100', intentId: 'solo' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);
});
