// Validation paths of spawn and transfer, which run BEFORE any chain call - so
// the stubs below are never reached, and a test that starts touching them is
// telling you an argument check moved after a side effect.

import { describe, it, expect } from 'bun:test';
import { decodeFunctionData } from 'viem';
import { TokenAbi } from '../src/abi.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Spawner } from '../src/spawn.ts';
import { loadPolicyDefaults, capToWei, WALLET_KINDS } from '../src/policy.ts';
import { Treasury, type Signer } from '../src/treasury.ts';
import { Store } from '../src/store.ts';
import { blankComments } from './support/source.ts';
import { asChainError } from '../src/chain.ts';
import { HttpError } from '../src/errors.ts';
import type { Config } from '../src/config.ts';
import type { Chain } from '../src/chain.ts';
import type { Keystore } from '../src/keystore.ts';
import type { Resolver } from '../src/resolver.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = loadPolicyDefaults(join(PKG, 'policy-defaults.json'), 'vee');

const config = {
  policyDir: '/tmp/does-not-exist',
  rpcUrl: 'http://chain:8545',
  policyDefaultsPath: join(PKG, 'policy-defaults.json'),
} as Config;

/// Throws on any access EXCEPT the module view.
///
/// `chain.modules` is local state built at boot, not a call - it is how a
/// handler learns the deployed token's scale and symbol, and reading it emits
/// no RPC. The property these tests guard is that validation refuses before any
/// CHAIN CALL, and a proxy that cannot tell a field read from a request would
/// fail them for the wrong reason.
const STUB_MODULES = {
  tokens: [{ key: 'vee', address: '0xvee', symbol: 'VEE', decimals: 18 }],
  names: { address: '0xreg', tld: 'vee' },
};

function exploding(what: string) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (what === 'chain' && prop === 'modules') return STUB_MODULES;
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
    expect(await codeOf(() => s.spawn({ agentId: 'client' }))).toBe('invalid_agent_id');
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

  // The condition and the message used to be separate lists, and the message
  // was PROSE - so the natural drift was a validator accepting a new kind
  // beside a message still calling it invalid, which sends the caller to fix
  // input that was already correct. Asserting the message against the CONSTANT
  // rather than against a fixed string means it stays true when the list grows,
  // without anyone remembering to update this test either.
  it('names every valid kind in the rejection message', async () => {
    const { spawner: s } = spawner();
    const err = await s.spawn({ agentId: 'orch:x', kind: 'wizard' }).catch((e: Error) => e);
    for (const kind of WALLET_KINDS) {
      expect((err as Error).message).toContain(kind);
    }
  });

  // STRUCTURAL, because a behavioural test CANNOT tell derivation from
  // coincidence here: with today's three kinds `WALLET_KINDS.join(', ')` is
  // byte-identical to the literal it replaced, so a test asserting the message
  // names each kind passes just as well on a hard-coded string. The drift only
  // becomes visible when the list changes - which is exactly when nobody is
  // running this test against the old message.
  //
  // Measured: re-hardcoding the message survived every behavioural test in this
  // file. So the thing to assert is the DERIVATION, not the output.
  // SCOPED TO parseKind's BODY, not to the file. A whole-file `toContain` is
  // satisfied by the join text appearing ANYWHERE - measured: hardcoding the
  // message while leaving `WALLET_KINDS.join` in a comment survived it. The
  // realistic version is not a planted comment but a SECOND site that
  // legitimately builds a message from the join, after which parseKind can be
  // hardcoded freely and this guard still passes.
  //
  // A source grep cannot tell you WHERE it matched, so the fix is to grep a
  // smaller thing: extract the function's own braces and look only in there.
  it('builds the rejection message FROM the constant, inside parseKind itself', async () => {
    // Comments blanked FIRST: this scan counts braces, and a `}` in prose
    // inside the function truncated the extracted body, so the guard reddened
    // on a comment rather than on a defect. Same bug as fees.test.ts's phantom
    // block, same fix, one helper - a second copy would be a second authority
    // for the rule these guards exist to enforce.
    const src = blankComments(await Bun.file(new URL('../src/spawn.ts', import.meta.url)).text());
    const at = src.indexOf('private parseKind(');
    // Compare to a VALUE: indexOf returns -1 when the function is renamed, and
    // slicing from -1 would silently search the whole file backwards.
    expect(at).toBeGreaterThan(-1);
    const open = src.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(open, end + 1);
    expect(body).toContain("WALLET_KINDS.join(', ')");
    // A narrow regression guard against the exact literal that was here before -
    // documented as narrow, not read as a general ban on the words.
    expect(body).not.toContain("'kind must be one of org, agent, burner'");
  });

  // The constant drives BEHAVIOUR, not only the message: every kind it lists
  // must get PAST validation, or the list is documentation the validator
  // happens to agree with today.
  //
  // Scoped to exactly that claim. This fixture's resolver explodes on contact,
  // so reaching it PROVES validation passed the kind through and proves nothing
  // else - which is the whole of what WALLET_KINDS governs. A full spawn would
  // exercise funding, registration and the chain, and pass or fail for reasons
  // that have nothing to do with this constant.
  it('lets every kind the constant lists through validation', async () => {
    for (const kind of WALLET_KINDS) {
      const { spawner: s } = spawner();
      const err = await s.spawn({ agentId: `orch:k-${kind}`, kind }).catch((e: Error) => e);
      expect((err as Error).message).toContain('resolver must not be reached');
    }
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
    store.markSpawned('orch:shadowbroker', '0x1111111111111111111111111111111111111111', null);

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
      deployment: { VEEBux: '0x3', NameRegistry: '0x4', treasury: '0x5', chainId: 31337 }, modules: { tokens: [{ key: 'vee', address: '0x3', symbol: 'VEE', decimals: 18 }], names: { address: '0x4', tld: 'vee' } },
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
      // Name-aware rather than answering the same wallet for everything: the
      // default deny list contains `treasury.vee`, and a stub claiming that
      // resolves to THIS wallet makes it look like a vanity alias, which the
      // canonical-deny check then correctly refuses.
      lookup: async (name: string) =>
        name === 'treasury.vee'
          ? { address: '0x0000000000000000000000000000000000007777', canonical: 'treasury.vee' }
          : { address, canonical: 'orch:shadowbroker' },
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
// deliberately do not assert the numbers, which are the spec's to move
// without breaking a build.
describe('policy defaults', () => {
  // Iterates WALLET_KINDS rather than a literal list, so adding a kind extends
  // this test automatically - and a kind added with no defaults fails at
  // STARTUP (loadPolicyDefaults throws by name) rather than at the first spawn
  // of that kind. Measured: adding 'wizard' to the constant stops the service
  // with `policy defaults ... have no valid "wizard" entry`.
  it('has an entry for every wallet kind', () => {
    for (const kind of WALLET_KINDS) {
      // Compared in WEI, not as numbers: a cap may be a decimal string, and
      // comparing those numerically is the imprecision the string form exists
      // to prevent.
      expect(capToWei(DEFAULTS[kind].max_per_tx, 18)).toBeGreaterThan(0n);
      expect(capToWei(DEFAULTS[kind].max_per_stage, 18)).toBeGreaterThanOrEqual(
        capToWei(DEFAULTS[kind].max_per_tx, 18),
      );
      // The file ships `treasury.{tld}`; this is the substitution having
      // happened, asserted through the value a wallet actually gets.
      expect(DEFAULTS[kind].deny).toContain('treasury.vee');
    }
  });

  // A missing or malformed file must stop the service rather than quietly
  // producing a wallet with no caps at all.
  it('refuses to load a missing or malformed defaults file', () => {
    expect(() => loadPolicyDefaults('/nope/policy-defaults.json', 'vee')).toThrow(/cannot read policy defaults/);
  });

  // §4.7. A pattern naming a TLD can match nothing on a deployment that
  // resolves no names, so it is DROPPED rather than kept as a literal
  // containing `{tld}` - which would read as a rule and match nothing.
  it('drops the TLD patterns when a deployment has no names module, and says so once', () => {
    const lines: string[] = [];
    const defaults = loadPolicyDefaults(join(PKG, 'policy-defaults.json'), undefined, (m) => lines.push(m));

    expect(defaults.agent.deny).toEqual([]);
    expect(defaults.agent.allow).toEqual([]);
    // `*` names no TLD, so it survives: the org default still allows anything.
    expect(defaults.org.allow).toEqual(['*']);
    expect(defaults.org.deny).toEqual([]);

    // Nothing anywhere contains an unfilled placeholder.
    for (const kind of ['org', 'agent', 'burner'] as const) {
      for (const p of [...defaults[kind].allow, ...defaults[kind].deny]) {
        expect(p).not.toContain('{tld}');
      }
    }

    // ONE LINE PER DISTINCT PATTERN, not per kind and not per agent: three
    // kinds share `treasury.{tld}` and two share `*.{tld}`.
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.includes('treasury.{tld}'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('*.{tld}'))).toHaveLength(1);
  });

  it('does not repeat the dropped-pattern line on a second load in the same process', () => {
    const lines: string[] = [];
    loadPolicyDefaults(join(PKG, 'policy-defaults.json'), undefined, (m) => lines.push(m));
    expect(lines).toHaveLength(0);

    const bad = join(mkdtempSync(join(tmpdir(), 'policy-')), 'p.json');
    writeFileSync(bad, JSON.stringify({ org: {}, agent: {}, burner: {} }));
    expect(() => loadPolicyDefaults(bad, 'vee')).toThrow(/no valid/);

    const negative = join(mkdtempSync(join(tmpdir(), 'policy-')), 'p.json');
    writeFileSync(
      negative,
      JSON.stringify({
        org: DEFAULTS.org,
        agent: { ...DEFAULTS.agent, max_per_tx: -1 },
        burner: DEFAULTS.burner,
      }),
    );
    expect(() => loadPolicyDefaults(negative, 'vee')).toThrow(/no valid "agent"/);
  });

  // A bad CAP is invalid_amount, a bad LIST is invalid_request: a cap is an
  // amount, and a caller sending 25.5 has made an amount mistake rather than a
  // malformed-request one (ruled).
  it('rejects a caller-supplied policy of the wrong shape', async () => {
    const { spawner: s } = spawner();
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', policy: { max_per_tx: 0 } }))).toBe('invalid_amount');
    expect(await codeOf(() => s.spawn({ agentId: 'orch:x', policy: { max_per_tx: 25.5 } }))).toBe(
      'invalid_amount',
    );
    expect(
      await codeOf(() => s.spawn({ agentId: 'orch:x', policy: { ...DEFAULTS.agent, allow: [1] } })),
    ).toBe('invalid_request');
  });

  // A3, the spawn side. The canonical-deny rule was enforced on the PATCH path
  // only, so `POST /wallets` accepted a vanity-alias deny that PATCH refused -
  // the same document, two rule sets, in the other direction.
  it('refuses a vanity-alias deny at spawn, as PATCH does', async () => {
    const store = new Store(':memory:');
    const s = new Spawner(
      { ...config, policyDir: mkdtempSync(join(tmpdir(), 'policies-')) } as Config,
      exploding('chain') as Chain,
      exploding('keystore') as Keystore,
      store,
      {
        lookup: async (name: string) =>
          name === 'mark.vee'
            ? { address: '0x000000000000000000000000000000000000dEaD', canonical: 'orch:mark' }
            : null,
      } as unknown as Resolver,
      DEFAULTS,
    );

    const code = await codeOf(() =>
      s.spawn({ agentId: 'orch:x', kind: 'agent', policy: { deny: ['mark.vee'] } }),
    );
    expect(code).toBe('invalid_request');
  });

  // The shape the harness sends, at the endpoint rather than at the merge helper:
  // this is the call that returned 400 against a live stack.
  it('accepts a partial policy at spawn, the harness shape', async () => {
    const { spawner: s } = spawner();
    const code = await codeOf(() =>
      s.spawn({ agentId: 'orch:x', policy: { allow: ['acme:*'], deny: ['treasury.vee'] } }),
    );
    // Reaches the chain rather than being refused on the policy - the exploding
    // stub is how we know it got past validation.
    expect(code).not.toBe('invalid_request');
    expect(code).not.toBe('invalid_amount');
  });
});

// THE RELEASE RULE, tested where it can actually go wrong. The store tests
// prove the reservation is atomic; these prove signTransfer does not hand it
// back after the money may already have moved.
// The bound recorded at reservation must be the observed HEAD, not the cursor.
// They are equal after a clean poll, so only a store where they DIVERGE can
// tell the two apart - and that divergence is exactly the window a transfer
// lands in, which is why the cursor is unsound.
describe('the reservation records a sound lower bound', () => {
  it('records the observed head, not the cursor, when they differ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({ agentId: 'orch:a', max_per_tx: 1000, max_per_stage: 5000, allow: ['*'], deny: [], frozen: false }),
    );
    const store = new Store(':memory:');
    store.setObservedHead(10n);
    store.setCursor('chain-log-tail', 3n); // processed less than it has looked at

    class FailingTreasury extends Treasury {
      protected signerFor(): Signer {
        return {
          prepareTransactionRequest: async (r: Record<string, unknown>) => r,
          signTransaction: async () => '0xsigned' as const,
          sendRawTransaction: async () => {
            throw new Error('socket hang up'); // leaves the reservation unresolved
          },
        };
      }
    }
    const t = new FailingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: { VEEBux: '0x000000000000000000000000000000000000dEaD' }, modules: { tokens: [{ key: 'vee', address: '0x000000000000000000000000000000000000dEaD', symbol: 'VEE', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      store,
      { require: async () => ({ address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:bob' }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.vee' ? null : ({ address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:bob' })) } as unknown as Resolver,
      DEFAULTS,
    );

    await t.signTransfer(asWallet('orch:a'), { to: 'bob.vee', vee: '1', intentId: 'bounded' }).catch(() => undefined);

    const row = store.unresolvedIntents().find((r) => r.intentId === 'bounded');
    expect(row?.reservedAtBlock).toBe(10n); // the observed head, not the cursor's 3
    store.close();
  }, 20_000);
});

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
        { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.vee' ? null : ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null })) } as unknown as Resolver,
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
        // A REPLAY CARRIES THEM TOO. Resolution happens before the reservation
        // is consulted, so the replay knows whom it paid and by which rule -
        // and a caller that gets the original hash back without them would have
        // to guess whether the id it used still means the same wallet.
        canonical: null,
        resolvedVia: 'exact',
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

  // Structural, and deliberately so: the review warning was that a SECOND
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
    { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.vee' ? null : ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null })) } as unknown as Resolver,
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
      { viemChain: {}, deployment: { VEEBux: '0x0' }, modules: { tokens: [{ key: 'vee', address: '0x0', symbol: 'VEE', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      new Store(':memory:'),
      { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.vee' ? null : ({ address: '0x000000000000000000000000000000000000dEaD', canonical: null })) } as unknown as Resolver,
      DEFAULTS,
    );
  }

  /// Same harness, but the resolver reports a CANONICAL that differs from the
  /// requested name - which is what an alias is.
  async function treasuryResolving(canonical: string, deny: string[]): Promise<CountingTreasury> {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({ agentId: 'orch:a', max_per_tx: 1000, max_per_stage: 5000, allow: ['*'], deny, frozen: false }),
    );
    return new CountingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: { VEEBux: '0x0' }, modules: { tokens: [{ key: 'vee', address: '0x0', symbol: 'VEE', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      new Store(':memory:'),
      { require: async () => ({ address: '0x000000000000000000000000000000000000dEaD', canonical }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.vee' ? null : ({ address: '0x000000000000000000000000000000000000dEaD', canonical })) } as unknown as Resolver,
      DEFAULTS,
    );
  }

  // THE RULED TEST, end to end. The unit tests pass `canonical` in by
  // hand, so they prove enforcePolicy uses it - they cannot prove signTransfer
  // RESOLVES FIRST and hands it over. Measured: with the call site reverted to
  // the pre-resolution order, every unit test still passes and this one fails.
  it('refuses an ALIAS of a denied wallet, and never reaches the chain', async () => {
    const t = await treasuryResolving('treasury.vee', ['treasury.vee']);
    const code = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'treasure.vee', vee: '1', intentId: 'alias-1' }),
    );
    expect(code).toBe('counterparty_denied');
    expect(t.broadcasts).toBe(0);
  }, 20_000);

  // The control: the same wallet, not denied, must still go through - otherwise
  // a probe that refuses everything would pass the test above.
  it('still sends to an alias whose wallet is not denied', async () => {
    const t = await treasuryResolving('orch:bob', []);
    await t.signTransfer(asWallet('orch:a'), { to: 'bob.vee', vee: '1', intentId: 'alias-2' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);

  /// A resolver where a deny entry and the requested name are DIFFERENT names
  /// for the SAME address - the case no amount of string matching can catch.
  async function treasuryWithAliases(deny: string[], sameAddress: string[]): Promise<CountingTreasury> {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({ agentId: 'orch:a', max_per_tx: 1000, max_per_stage: 5000, allow: ['*'], deny, frozen: false }),
    );
    const SHARED = '0x000000000000000000000000000000000000bEEF';
    const OTHER = '0x000000000000000000000000000000000000dEaD';
    const addressOf = (n: string) => (sameAddress.includes(n) ? SHARED : OTHER);
    return new CountingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: { VEEBux: '0x0' }, modules: { tokens: [{ key: 'vee', address: '0x0', symbol: 'VEE', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      new Store(':memory:'),
      {
        require: async (n: string) => ({ address: addressOf(n), canonical: 'orch:someone' }),
        // No NAMESPACE PEERS in this fixture: a real registry resolves the
        // names that exist, and `orch:marky.vee` does not. A blanket resolver
        // makes every bare name ambiguous with its own constructed peer.
        lookup: async (n: string) =>
          n.includes(':') ? null : { address: addressOf(n), canonical: 'orch:someone' },
      } as unknown as Resolver,
      DEFAULTS,
    );
  }

  // THE CASE NAME MATCHING CANNOT REACH. The deny names one alias; the caller
  // uses a DIFFERENT alias of the same wallet. Neither string matches the entry
  // and the canonical matches neither, so only comparing ADDRESSES catches it.
  it('refuses a wallet denied under a different alias entirely', async () => {
    const t = await treasuryWithAliases(['mark.vee'], ['mark.vee', 'marky.vee']);
    const code = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.vee', vee: '1', intentId: 'id-1' }),
    );
    expect(code).toBe('counterparty_denied');
    expect(t.broadcasts).toBe(0);
  }, 20_000);

  // The control: a different wallet with a similar name still goes through, so
  // the identity check is not simply refusing everything.
  it('still sends to a DIFFERENT wallet when a deny entry exists', async () => {
    const t = await treasuryWithAliases(['mark.vee'], ['mark.vee']);
    await t.signTransfer(asWallet('orch:a'), { to: 'someone-else.vee', vee: '1', intentId: 'id-2' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);

  // A deny-entry resolve that FAILS is not the same as one that finds nothing,
  // and they now get opposite answers (ruled). Splitting them is the
  // whole point: "there is no such denied identity" is an answer, "I could not
  // find out" is not.
  function treasuryWhoseLookup(lookup: (n: string) => Promise<unknown>): CountingTreasury {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    writeFileSync(
      join(dir, 'orch%3Aa.json'),
      JSON.stringify({
        agentId: 'orch:a', max_per_tx: 1000, max_per_stage: 5000,
        allow: ['*'], deny: ['mark.vee'], frozen: false,
      }),
    );
    return new CountingTreasury(
      { ...config, policyDir: dir } as Config,
      { viemChain: {}, deployment: { VEEBux: '0x0' }, modules: { tokens: [{ key: 'vee', address: '0x0', symbol: 'VEE', decimals: 18 }] }, publicClient: { waitForTransactionReceipt: async () => ({}) } } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: '0x' }) } as unknown as Keystore,
      new Store(':memory:'),
      {
        require: async () => ({ address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:someone' }),
        // The callback models THE DENY ENTRY's registry state over time, which
        // is what every test here varies. Since §5 the resolution path calls
        // `lookup` too, so the TARGET is resolved explicitly rather than
        // falling into the callback and making every test also a test of
        // whether `marky.vee` exists - which none of them are about.
        //
        // Wrapped the way the real Resolver.lookup wraps: a failed registry
        // read reaches callers as a chain error, never as a raw Error, so a
        // stub that throws raw would be testing a collaborator that does not
        // exist.
        lookup: async (n: string) => {
          if (n === 'marky.vee') {
            return { address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:someone' };
          }
          if (n.includes(':')) return null; // no namespace peers in this fixture
          try {
            return await lookup(n);
          } catch (err) {
            throw asChainError(err);
          }
        },
      } as unknown as Resolver,
      DEFAULTS,
    );
  }

  // READ FAILED -> refuse. Admitting a transfer we could not evaluate the deny
  // list against errs in the one direction a cap must not.
  it('refuses when a deny entry cannot be resolved, rather than sending anyway', async () => {
    const t = treasuryWhoseLookup(async () => {
      throw new Error('registry read failed');
    });
    const code = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.vee', vee: '1', intentId: 'f-1' }),
    );
    expect(['chain_error', 'chain_unreachable']).toContain(code);
    expect(t.broadcasts).toBe(0);
  }, 20_000);

  // NOT FOUND -> proceed. An unregistered deny entry names no identity, which
  // is a real answer and not an unknown.
  it('sends when a deny entry names nothing registered', async () => {
    const t = treasuryWhoseLookup(async () => null);
    await t.signTransfer(asWallet('orch:a'), { to: 'marky.vee', vee: '1', intentId: 'f-2' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);

  // The failure is not cached, so a registry that recovers starts denying
  // again. Caching it would turn one failed read into a wallet un-denied for
  // the life of the process.
  it('does not remember a failed resolve, so recovery restores the deny', async () => {
    let calls = 0;
    const t = treasuryWhoseLookup(async () => {
      if (++calls === 1) throw new Error('registry read failed');
      return { address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:someone' };
    });

    const first = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.vee', vee: '1', intentId: 'f-3' }),
    );
    expect(['chain_error', 'chain_unreachable']).toContain(first);

    const second = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.vee', vee: '1', intentId: 'f-4' }),
    );
    expect(second).toBe('counterparty_denied');
    expect(t.broadcasts).toBe(0);
  }, 20_000);

  // A REVIEW'S FIXTURE, one line different from the read-failure one and the
  // difference is the whole finding: a deny entry that is NOT YET REGISTERED
  // resolves to null, and "not registered" is as transient as "read failed" -
  // names get registered, that is what the game does. Deny a counterparty by
  // canonical id BEFORE that agent is spawned, spawn it, and a cached null
  // un-denies its aliases for the life of the process.
  it('denies a wallet whose deny entry was registered AFTER an earlier send', async () => {
    let registered = false;
    const t = treasuryWhoseLookup(async () =>
      registered ? { address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:mark' } : null,
    );

    // First send: the deny entry names nothing yet, so nothing matches.
    await t.signTransfer(asWallet('orch:a'), { to: 'marky.vee', vee: '1', intentId: 'l-1' });
    expect(t.broadcasts).toBe(1);

    // The name is now registered, to the same wallet the alias points at.
    registered = true;

    const code = await codeOf(() =>
      t.signTransfer(asWallet('orch:a'), { to: 'marky.vee', vee: '1', intentId: 'l-2' }),
    );
    expect(code).toBe('counterparty_denied');
    expect(t.broadcasts).toBe(1); // still one: the second never reached the chain
  }, 20_000);

  // And the other direction, which a cached POSITIVE would get wrong:
  // `setTargetFor` re-points a name and retirement clears it, so a resolution
  // that was correct once can stop being correct.
  it('stops denying once the deny entry no longer resolves to that wallet', async () => {
    let pointsAtTarget = true;
    const t = treasuryWhoseLookup(async () =>
      pointsAtTarget
        ? { address: '0x000000000000000000000000000000000000bEEF', canonical: 'orch:mark' }
        : { address: '0x000000000000000000000000000000000000dEaD', canonical: 'orch:mark' },
    );

    expect(
      await codeOf(() => t.signTransfer(asWallet('orch:a'), { to: 'marky.vee', vee: '1', intentId: 'l-3' })),
    ).toBe('counterparty_denied');

    pointsAtTarget = false;
    await t.signTransfer(asWallet('orch:a'), { to: 'marky.vee', vee: '1', intentId: 'l-4' });
    expect(t.broadcasts).toBe(1);
  }, 20_000);

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

// Harness spec S3. Set-balance is the one endpoint that can move money OUT of an
// agent's wallet, so the tests are about what it CANNOT do as much as what it can.
describe('POST /wallets/:agentId/balance', () => {
  const WALLET = '0x000000000000000000000000000000000000bEEF';
  const TREASURY = '0x0000000000000000000000000000000000007777';
  const vee = (n: number) => BigInt(n) * 10n ** 18n;

  /// Records every transfer the chain was asked to make, so a test can assert
  /// the DESTINATION and not just the resulting balance.
  class RecordingTreasury extends Treasury {
    sent: Array<{ to: string; amount: bigint }> = [];
    balance = 0n;
    /// Decodes the calldata and MOVES THE BALANCE, so the re-read at the end of
    /// setBalance sees what a real chain would. A fake that accepted the
    /// transfer without applying it would make the outcome-vs-intention test
    /// pass for the wrong reason - it would be reading a number that never
    /// changed, which is the defect the re-read exists to catch.
    protected signerFor(): Signer {
      let pending = 0n;
      return {
        prepareTransactionRequest: async (req: Record<string, unknown>) => {
          const { args } = decodeFunctionData({ abi: TokenAbi, data: req.data as `0x${string}` });
          pending = (args as readonly [string, bigint])[1];
          return req;
        },
        signTransaction: async () => '0xsigned' as const,
        sendRawTransaction: async () => {
          this.balance -= pending;
          this.sent.push({ to: TREASURY, amount: pending });
          return '0xswept' as `0x${string}`;
        },
      };
    }
  }

  function treasuryAt(balance: bigint, frozen = false): { t: RecordingTreasury; store: Store } {
    const store = new Store(':memory:');
    store.markSpawned('orch:a', WALLET, null);
    if (frozen) store.freeze('orch:a');
    const t = new RecordingTreasury(
      { ...config, policyDir: '/tmp/none' } as Config,
      {
        viemChain: {},
        deployment: { VEEBux: '0xvee', treasury: TREASURY }, modules: { tokens: [{ key: 'vee', address: '0xvee', symbol: 'VEE', decimals: 18 }] },
        publicClient: {
          readContract: async () => t.balance,
          waitForTransactionReceipt: async () => ({}),
        },
        walletClient: {
          account: {},
          writeContract: async ({ args }: { args: [string, bigint] }) => {
            t.sent.push({ to: args[0], amount: args[1] });
            t.balance += args[1];
            return '0xfunded' as `0x${string}`;
          },
        },
      } as unknown as Chain,
      { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: WALLET }) } as unknown as Keystore,
      store,
      { require: async () => ({ address: WALLET, canonical: 'orch:a' }), lookup: async (n: string) => (n.includes(':') || n === 'treasury.vee' ? null : ({ address: WALLET, canonical: 'orch:a' })) } as unknown as Resolver,
      DEFAULTS,
    );
    t.balance = balance;
    return { t, store };
  }

  // Review recorded this against the pre-merge trees: `setBalance` reserves an
  // intent, and its TOP-UP branch called `fund` without it while the SWEEP
  // branch passed it through - so a top-up was the one money movement whose
  // intent could not be joined from /history. Both sides compiled, which is why
  // it needed a test rather than a rebase.
  it('a TOP-UP records the intent id on its memo', async () => {
    const { t, store } = treasuryAt(vee(10));
    await t.setBalance('orch:a', { vee: '100', intentId: 'top-up-1' });
    expect(store.memosFor(['0xfunded']).get('0xfunded')?.intentId).toBe('top-up-1');
  }, 20_000);

  it('a SWEEP records the intent id on its memo', async () => {
    const { t, store } = treasuryAt(vee(100));
    await t.setBalance('orch:a', { vee: '40', intentId: 'sweep-1' });
    expect(store.memosFor(['0xswept']).get('0xswept')?.intentId).toBe('sweep-1');
  }, 20_000);

  it('funds the difference when the balance is below target', async () => {
    const { t } = treasuryAt(vee(10));
    const res = await t.setBalance('orch:a', { vee: '100', intentId: 'b-1' });
    expect(res.balance).toBe('100');
    expect(t.sent).toEqual([{ to: WALLET, amount: vee(90) }]);
  }, 20_000);

  it('sweeps the difference to the TREASURY when above target', async () => {
    const { t } = treasuryAt(vee(100));
    const res = await t.setBalance('orch:a', { vee: '40', intentId: 'b-2' });
    expect(res.balance).toBe('40');
    expect(res.txHash).toBe('0xswept');
  }, 20_000);

  // A4. The reply used to be `formatVee(target)` at both exits - the INTENTION,
  // not the outcome, since `current` was read several awaits before the
  // transfer landed. It is what the harness's Wallets panel shows.
  it('reports the MEASURED balance, not the one it intended to set', async () => {
    const { t } = treasuryAt(vee(100));

    // The chain applies only part of the sweep - a partial fill, a fee, any
    // reason the outcome differs from the intention.
    const realSigner = (t as unknown as { signerFor: () => Signer }).signerFor.bind(t);
    (t as unknown as { signerFor: () => Signer }).signerFor = () => {
      const s = realSigner();
      return { ...s, sendRawTransaction: async () => { t.balance = vee(42); return '0xpartial' as `0x${string}`; } };
    };

    const res = await t.setBalance('orch:a', { vee: '40', intentId: 'b-measured' });

    // 42, what the chain holds - not 40, what we asked for.
    expect(res.balance).toBe('42');
  }, 20_000);

  it('does nothing at all when the balance is already correct', async () => {
    const { t } = treasuryAt(vee(50));
    const res = await t.setBalance('orch:a', { vee: '50', intentId: 'b-3' });
    expect(res).toEqual({ balance: '50' });
    expect(res.txHash).toBeUndefined();
    expect(t.sent).toHaveLength(0);
  }, 20_000);

  // An operator resetting is not an agent spending, so the freeze does not stop
  // it. This is the invariant sweepToTreasury changes, asserted rather than
  // described.
  it('sets the balance of a FROZEN wallet', async () => {
    const { t } = treasuryAt(vee(100), true);
    const res = await t.setBalance('orch:a', { vee: '40', intentId: 'b-4' });
    expect(res.balance).toBe('40');
  }, 20_000);

  // THE CONTAINMENT. Not "a `to` field is ignored" - a body carrying one is
  // REFUSED, because an ignored field is one somebody wires up later.
  it('refuses a body that tries to name a destination', async () => {
    const { t } = treasuryAt(vee(100));
    const code = await codeOf(() =>
      t.setBalance('orch:a', { vee: '40', to: '0xattacker', intentId: 'b-5' }),
    );
    expect(code).toBe('invalid_request');
    expect(t.sent).toHaveLength(0);
  }, 20_000);

  // Idempotency has two halves here and they are different mechanisms.
  //
  // The cheap half: once the balance IS the target, a repeat is a no-op before
  // any reservation is consulted, because "already correct" is the answer.
  it('a repeat after success moves nothing, because the balance is already right', async () => {
    const { t } = treasuryAt(vee(10));
    await t.setBalance('orch:a', { vee: '100', intentId: 'same' });
    const before = t.sent.length;

    const again = await t.setBalance('orch:a', { vee: '100', intentId: 'same' });

    expect(again).toEqual({ balance: '100' });
    expect(t.sent).toHaveLength(before);
  }, 20_000);

  // The half that matters: the caller RETRIES because it never saw the
  // response, so from its side nothing happened - and here the balance has not
  // settled either. Only the intent reservation can tell these apart, and it
  // answers with the original transaction instead of funding a second time.
  it('replays the original transaction when the caller retries a lost response', async () => {
    const { t } = treasuryAt(vee(10));
    const first = await t.setBalance('orch:a', { vee: '100', intentId: 'same' });
    const before = t.sent.length;

    t.balance = vee(10); // the retry sees the pre-transfer state

    const second = await t.setBalance('orch:a', { vee: '100', intentId: 'same' });

    expect(second.txHash).toBe(first.txHash);
    expect(t.sent).toHaveLength(before); // and did NOT fund again
  }, 20_000);

  // Platform scope has no stage cap, so a large reset is not refused as
  // over_stage_cap - the null cap hold, asserted through the endpoint.
  it('is not subject to the stage cap', async () => {
    const { t, store } = treasuryAt(vee(0));
    const res = await t.setBalance('orch:a', { vee: '100000', intentId: 'b-6' });
    expect(res.balance).toBe('100000');
    expect(store.spentThisStage('orch:a', store.currentStage())).toBe(0n);
  }, 20_000);
});

// Harness spec S3. The only way back from frozen; DELETE /wallets keeps meaning
// retirement and stays irreversible.
describe('PATCH /wallets/:agentId/policy', () => {
  function spawnerWith(canonicalOf: Record<string, string> = {}): { s: Spawner; store: Store; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const store = new Store(':memory:');
    store.markSpawned('orch:a', '0x000000000000000000000000000000000000bEEF', null);
    const s = new Spawner(
      { ...config, policyDir: dir } as Config,
      exploding('chain') as Chain,
      exploding('keystore') as Keystore,
      store,
      {
        lookup: async (n: string) =>
          canonicalOf[n] ? { address: '0x000000000000000000000000000000000000dEaD', canonical: canonicalOf[n] } : null,
      } as unknown as Resolver,
      DEFAULTS,
    );
    return { s, store, dir };
  }

  const read = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'orch%3Aa.json'), 'utf8')) as Record<string, unknown>;

  // Every field, both directions: the one supplied changes and EVERY omitted
  // one survives. Asserting only the supplied field would leave the fallbacks
  // untested - a patch that quietly reset an omitted cap to a default would
  // pass, and that is a cap silently lowered or raised on a live wallet.
  it('updates only the fields present, leaving every other one alone', async () => {
    const { s, dir } = spawnerWith();

    await s.patchPolicy('orch:a', { max_per_stage: 4242 });

    const p = read(dir);
    expect(p.max_per_stage).toBe(4242);
    expect(p.max_per_tx).toBe(DEFAULTS.agent.max_per_tx);
    expect(p.allow).toEqual(DEFAULTS.agent.allow);
    expect(p.deny).toEqual(DEFAULTS.agent.deny);
  }, 20_000);

  it('preserves an earlier patch when a later one touches a different field', async () => {
    const { s, dir } = spawnerWith();
    await s.patchPolicy('orch:a', { max_per_tx: 250 });
    await s.patchPolicy('orch:a', { max_per_stage: 999 });
    const p = read(dir);
    expect(p.max_per_tx).toBe(250); // not reset by the second patch
    expect(p.max_per_stage).toBe(999);
  }, 20_000);

  it('flips frozen both ways, and the store agrees with the file', async () => {
    const { s, store, dir } = spawnerWith();

    await s.patchPolicy('orch:a', { frozen: true });
    expect(store.isFrozen('orch:a')).toBe(true);
    expect(read(dir).frozen).toBe(true);

    await s.patchPolicy('orch:a', { frozen: false });
    expect(store.isFrozen('orch:a')).toBe(false);
    expect(read(dir).frozen).toBe(false);
  }, 20_000);

  // The store is what /sign-transfer consults, so this is the property that
  // actually stops and restarts spending - the file is wallet-mcp's copy.
  it('the freeze the next /sign-transfer honours is the STORE, not the file', async () => {
    const { s, store } = spawnerWith();
    await s.patchPolicy('orch:a', { frozen: true });
    expect(store.isFrozen('orch:a')).toBe(true);
    await s.patchPolicy('orch:a', { frozen: false });
    expect(store.isFrozen('orch:a')).toBe(false);
  }, 20_000);

  // §5's durable rule: a deny entry names a canonical id or a platform name.
  // The two are indistinguishable by shape, so the registry decides.
  it('refuses a deny entry that is a vanity alias', async () => {
    const { s } = spawnerWith({ 'mark.vee': 'orch:mark' });
    const code = await codeOf(() => s.patchPolicy('orch:a', { deny: ['mark.vee'] }));
    expect(code).toBe('invalid_request');
  }, 20_000);

  it('accepts a deny entry that IS the canonical name for its address', async () => {
    const { s, dir } = spawnerWith({ 'treasury.vee': 'treasury.vee' });
    await s.patchPolicy('orch:a', { deny: ['treasury.vee'] });
    expect(read(dir).deny).toEqual(['treasury.vee']);
  }, 20_000);

  // Accepted on purpose: it names no identity today, and refusing it would make
  // a policy un-writable until the wallet it names exists - inverting the spawn
  // order the harness needs.
  it('accepts a deny entry that resolves to nothing yet', async () => {
    const { s, dir } = spawnerWith();
    await s.patchPolicy('orch:a', { deny: ['orch:notyet'] });
    expect(read(dir).deny).toEqual(['orch:notyet']);
  }, 20_000);

  it('refuses a malformed pattern in either list', async () => {
    const { s } = spawnerWith();
    expect(await codeOf(() => s.patchPolicy('orch:a', { deny: ['a*b'] }))).toBe('invalid_request');
    expect(await codeOf(() => s.patchPolicy('orch:a', { allow: ['a*b'] }))).toBe('invalid_request');
  }, 20_000);

  // Same codes as POST /wallets now, because it is the same validator: a bad
  // CAP is invalid_amount, a bad LIST is invalid_request.
  it('refuses a cap that is not an amount, with the same code POST uses', async () => {
    const { s } = spawnerWith();
    for (const bad of [0, -5, 1.5, '', 'lots', null]) {
      expect(await codeOf(() => s.patchPolicy('orch:a', { max_per_tx: bad }))).toBe('invalid_amount');
    }
  }, 20_000);

  // A2/A3: a wallet must be patchable in the form it was spawned with.
  it('accepts a STRING cap, the form POST /wallets accepts', async () => {
    const { s, dir } = spawnerWith();
    await s.patchPolicy('orch:a', { max_per_tx: '25' });
    expect(read(dir).max_per_tx).toBe('25');
  }, 20_000);

  it('refuses to patch a wallet that does not exist', async () => {
    const { s } = spawnerWith();
    expect(await codeOf(() => s.patchPolicy('orch:nobody', { frozen: true }))).toBe('wallet_not_found');
  }, 20_000);
});

// ── The kind reaches the STORE ──────────────────────────────────────────────
//
// The column round-trips and the endpoint reads it - and neither shows that
// SPAWN puts the real kind in. Measured: replacing `kind` with `null` at
// `spawn.ts`'s markSpawned call left every other test in this package green,
// which is the same defect as the bare-id counter that nothing read. A value
// recorded by nobody and a value recorded wrongly are both invisible to tests
// of the recorder.
describe('spawn records the kind it enforced', () => {
  const completing = (store: Store) => {
    const address = '0x000000000000000000000000000000000000bEEF';
    const chain = {
      viemChain: {},
      deployment: { VEEBux: '0x0', NameRegistry: '0x1' }, modules: { tokens: [{ key: 'vee', address: '0x0', symbol: 'VEE', decimals: 18 }], names: { address: '0x1', tld: 'vee' } },
      publicClient: {
        getBalance: async () => 10n ** 18n,      // already endowed
        readContract: async () => 10n ** 30n,    // already funded
        waitForTransactionReceipt: async () => ({}),
      },
      walletClient: {
        account: { address: '0x5' },
        sendTransaction: async () => '0xdead',
        writeContract: async () => '0xbeef',
      },
    } as unknown as Chain;
    const keystore = { has: async () => true, load: async () => ({ address, privateKey: '0x00' }) } as unknown as Keystore;
    const resolver = {
      lookup: async (name: string) =>
        name === 'treasury.vee'
          ? { address: '0x0000000000000000000000000000000000007777', canonical: 'treasury.vee' }
          : { address, canonical: 'orch:kindwire' },
      reverseOf: async () => 'orch:kindwire',
      aliasesOf: async () => [],
    } as unknown as Resolver;
    return new Spawner(
      { ...config, policyDir: mkdtempSync(join(tmpdir(), 'policies-')) } as Config,
      chain, keystore, store, resolver, DEFAULTS,
    );
  };

  // `org` rather than `agent`: `parseKind` defaults to 'agent', so asserting
  // 'agent' would pass on a spawn that recorded nothing and let the default
  // answer for it.
  it('stores the kind the caller asked for, not the default', async () => {
    const store = new Store(':memory:');
    await completing(store).spawn({ agentId: 'orch:kindwire', kind: 'org' });
    expect(store.walletRow('orch:kindwire')?.kind).toBe('org');
    store.close();
  });

  // A burner takes the other registration branch, so this also pins that the
  // record does not depend on names having been registered.
  it('stores burner, which registers no names at all', async () => {
    const store = new Store(':memory:');
    await completing(store).spawn({ agentId: 'orch:kindburner', kind: 'burner' });
    expect(store.walletRow('orch:kindburner')?.kind).toBe('burner');
    store.close();
  });
});

// §4.4 / §8.4. THE TWO OPTIONAL HALVES OF A SPAWN, refused before anything is
// written. Both guards existed with no test until a mutation run said so:
// disabling either left the whole suite green.
//
// The assertion is not only the refusal but WHEN it happens. Refusing after
// keystore.create would leave a key file behind, and the retry after that
// refusal would take the idempotent path and report success for the request
// that was just refused - so each case checks the store has no spawn row and
// the keystore was never reached.
describe('a spawn refuses what this deployment cannot do', () => {
  function spawnerOn(modules: Record<string, unknown>): { s: Spawner; store: Store; touched: string[] } {
    const touched: string[] = [];
    const store = new Store(':memory:');
    const s = new Spawner(
      config,
      { modules } as unknown as Chain,
      new Proxy(
        {},
        {
          get(_t, prop) {
            touched.push(String(prop));
            throw new Error('the keystore must not be reached: the request was refused first');
          },
        },
      ) as Keystore,
      store,
      exploding('resolver') as Resolver,
      DEFAULTS,
    );
    return { s, store, touched };
  }

  const TOKENS = [{ key: 'vee', address: '0xvee', symbol: 'VEE', decimals: 18 }];
  const NAMES = { address: '0xreg', tld: 'vee' };

  it('refuses fundVee without a token module, before any side effect', async () => {
    const { s, store, touched } = spawnerOn({ tokens: [], names: NAMES });

    expect(await codeOf(() => s.spawn({ agentId: 'orch:a', fundVee: 10 }))).toBe('module_not_deployed');
    expect(touched).toEqual([]);
    expect(store.spawnedAddress('orch:a')).toBeNull();
    store.close();
  });

  it('refuses an alias without a names module, before any side effect', async () => {
    const { s, store, touched } = spawnerOn({ tokens: TOKENS });

    expect(await codeOf(() => s.spawn({ agentId: 'orch:a', alias: 'a.vee' }))).toBe('module_not_deployed');
    expect(touched).toEqual([]);
    expect(store.spawnedAddress('orch:a')).toBeNull();
    store.close();
  });

  // THE HALVES ARE INDEPENDENT. A spawn needs NEITHER module: a wallet is a
  // key, a token and a policy file, and all three exist on a deployment with no
  // contracts at all. Only the optional halves need one each - so asking for
  // neither must get past both guards, and the proof it got past them is that
  // it reached the keystore.
  it('lets a spawn asking for neither reach the keystore on a bare deployment', async () => {
    const { s, store, touched } = spawnerOn({ tokens: [] });

    await s.spawn({ agentId: 'orch:a' }).catch(() => undefined);
    expect(touched.length).toBeGreaterThan(0);
    store.close();
  });

  it('accepts fundVee zero without a token module, because nothing moves', async () => {
    const { s, store, touched } = spawnerOn({ tokens: [] });

    await s.spawn({ agentId: 'orch:a', fundVee: 0 }).catch(() => undefined);
    expect(touched.length).toBeGreaterThan(0);
    store.close();
  });
});
