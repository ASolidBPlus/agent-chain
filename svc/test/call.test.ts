// §8.3. THE CALL OP, driven end to end against a recording signer.
//
// The pattern is spawn.test.ts's: a Treasury with a subclassed signer that
// records what was signed rather than sending it. That matters more here than
// it did there, because the thing under test is an ORDER - kind, frozen,
// arguments, caps, reservation, sign - and a test that drove each check
// directly would stay green when the order changed. The defect the order
// prevents is a reservation taken for a call that is then refused, or a
// signature produced before the cap was consulted.
//
// The fixture contract is the Converter's real shape - `convert(address,
// address, uint256, bytes32)` - because it is the first real customer of the op
// and every rule in §2 has something to say about it: two address arguments
// with rules, an amount whose token is chosen per call, and an intent slot the
// server fills.

import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { decodeFunctionData, type Abi } from 'viem';
import { Treasury, type Signer } from '../src/treasury.ts';
import { Store } from '../src/store.ts';
import { HttpError } from '../src/errors.ts';
import { fixedCallPolicy, type CallEntry } from '../src/calls.ts';
import type { Chain } from '../src/chain.ts';
import type { Keystore } from '../src/keystore.ts';
import type { Resolver } from '../src/resolver.ts';
import type { Config } from '../src/config.ts';
import { loadPolicyDefaults } from '../src/policy.ts';
import { buildModules, type Modules } from '../src/modules.ts';
import type { Deployment } from '../src/chain.ts';

const PKG = join(import.meta.dir, '..');
const DEFAULTS = loadPolicyDefaults(join(PKG, 'policy-defaults.json'), 'play');
const config = { token: 't', rpcUrl: 'http://chain:8545', policyDir: '/policies' } as Config;

// CHECKSUMMED SPELLINGS, because that is what the registry stores (getAddress
// in loadDeployment) and what platform scope must pass. A lowercase constant
// here would have made every comparison against a resolved address fail, and
// every admin-call argument refused - which is the validator working.
const PLAY = '0x00000000000000000000000000000000000000AA';
const GOLD = '0x00000000000000000000000000000000000000bb';
const CONV = '0x00000000000000000000000000000000000000dd';
const BOB = '0x000000000000000000000000000000000000bEEF';

const fn = (
  name: string,
  inputs: Array<{ type: string; name: string }>,
  stateMutability: string,
  outputs: Array<{ type: string; name: string }> = [],
) => ({ type: 'function', name, inputs, outputs, stateMutability });

const CONVERTER_ABI = [
  fn(
    'convert',
    [
      { type: 'address', name: 'source' },
      { type: 'address', name: 'target' },
      { type: 'uint256', name: 'amountIn' },
      { type: 'bytes32', name: 'intentId' },
    ],
    'nonpayable',
  ),
  fn('donate', [{ type: 'address', name: 'to' }], 'nonpayable'),
  fn(
    'quote',
    [
      { type: 'address', name: 'source' },
      { type: 'address', name: 'target' },
      { type: 'uint256', name: 'amountIn' },
    ],
    'view',
    [{ type: 'uint256', name: 'amountOut' }],
  ),
  fn(
    'setPair',
    [
      { type: 'address', name: 'source' },
      { type: 'address', name: 'target' },
      { type: 'uint256', name: 'rate' },
    ],
    'nonpayable',
  ),
] as unknown as Abi;

const ABIS = { Token: [] as unknown as Abi, Converter: CONVERTER_ABI };

async function modules(): Promise<Modules> {
  const deployment = {
    schema: 1,
    chainId: 31337,
    treasury: PLAY,
    modules: [
      { kind: 'token', key: 'play', contract: 'Token', address: PLAY },
      { kind: 'token', key: 'gold', contract: 'Token', address: GOLD },
      { kind: 'converter', contract: 'Converter', address: CONV },
    ],
  } as unknown as Deployment;
  const meta: Record<string, { symbol: string; decimals: number }> = {
    [PLAY]: { symbol: 'PLAY', decimals: 18 },
    [GOLD]: { symbol: 'GOLD', decimals: 6 },
  };
  return buildModules(deployment, async (a) => meta[a]!, ABIS);
}

const abiFunction = (name: string) =>
  (CONVERTER_ABI as unknown as Array<{ type: string; name: string }>).find(
    (f) => f.type === 'function' && f.name === name,
  ) as never;

/// The §2 example entry, as the loader would have produced it.
const CONVERT: CallEntry = {
  contract: 'converter',
  function: 'convert',
  kinds: ['org', 'agent'],
  admin: false,
  read: false,
  amount: { arg: 2, token: { arg: 0 } },
  perTxCap: '100',
  intentArg: 3,
  maxPerStage: 2,
  addressArgs: { 0: 'token', 1: 'token' },
  abiFunction: abiFunction('convert'),
};

const DONATE: CallEntry = {
  contract: 'converter',
  function: 'donate',
  kinds: ['agent'],
  admin: false,
  read: false,
  addressArgs: { 0: 'name' },
  abiFunction: abiFunction('donate'),
};

/// An entry whose address parameter has NO rule. Legal to load - the loader
/// does not require rules, because an admin-only entry genuinely needs none -
/// and uncallable by a wallet, which is the property under test.
const UNRULED: CallEntry = {
  contract: 'converter',
  function: 'donate',
  kinds: ['agent'],
  admin: false,
  read: false,
  addressArgs: {},
  abiFunction: abiFunction('donate'),
};

const QUOTE: CallEntry = {
  contract: 'converter',
  function: 'quote',
  kinds: ['agent'],
  admin: false,
  read: true,
  addressArgs: { 0: 'token', 1: 'token' },
  abiFunction: abiFunction('quote'),
};

const SET_PAIR: CallEntry = {
  contract: 'converter',
  function: 'setPair',
  kinds: [],
  admin: true,
  read: false,
  addressArgs: {},
  abiFunction: abiFunction('setPair'),
};

interface Signed {
  to: string;
  data: `0x${string}`;
}

/// Records what was signed instead of sending it, and answers with a receipt.
class RecordingTreasury extends Treasury {
  readonly signed: Signed[] = [];
  reverted = false;

  protected override signerFor(): Signer {
    return {
      prepareTransactionRequest: async (a: Record<string, unknown>) => {
        this.signed.push({ to: String(a.to), data: a.data as `0x${string}` });
        return a;
      },
      signTransaction: async () => '0xsigned' as const,
      sendRawTransaction: async () => '0xhash' as const,
    } as unknown as Signer;
  }
}

async function harness(
  entries: CallEntry[] = [CONVERT, DONATE, QUOTE, SET_PAIR],
  opts: {
    reverted?: boolean;
    store?: Store;
    keystoreThrows?: boolean;
    /// Makes the name argument resolve to the SAME address as the deny entry
    /// `treasury.{tld}`, which is how a deny is evaded in the real world: the
    /// policy names one string and the caller uses another for the same wallet.
    nameIsDenied?: boolean;
  } = {},
): Promise<{ t: RecordingTreasury; store: Store }> {
  const store = opts.store ?? new Store(':memory:');
  store.markSpawned('orch:a', '0x000000000000000000000000000000000000aaaa', 'agent');
  store.markSpawned('orch:b', '0x000000000000000000000000000000000000bbbb', 'burner');
  store.markSpawned('orch:o', '0x000000000000000000000000000000000000cccc', 'org');

  const chain = {
    modules: await modules(),
    viemChain: { id: 31337 },
    publicClient: {
      waitForTransactionReceipt: async () => ({ status: opts.reverted ? 'reverted' : 'success' }),
      readContract: async () => 40n,
    },
    walletClient: {
      account: { address: PLAY },
      writeContract: async () => '0xadminhash',
    },
  } as unknown as Chain;

  const t = new RecordingTreasury(
    config,
    chain,
    {
      load: async () => {
        if (opts.keystoreThrows) throw new Error('keystore unreadable');
        return { privateKey: `0x${'11'.repeat(32)}`, address: '0x' };
      },
    } as unknown as Keystore,
    store,
    {
      require: async () => ({ address: BOB, canonical: 'orch:bob' }),
      // `treasury.play` must NOT resolve to the same address as the target:
      // it is on every kind's deny list, and a fixture that resolved both to
      // one address would make the identity pass refuse every call - correctly,
      // and for a reason that has nothing to do with what is under test.
      lookup: async (n: string) =>
        n === 'treasury.play'
          ? opts.nameIsDenied
            ? { address: BOB, canonical: 'treasury.play' }
            : null
          : { address: BOB, canonical: 'orch:bob' },
    } as unknown as Resolver,
    DEFAULTS,
    fixedCallPolicy(entries),
  );
  return { t, store };
}

const asWallet = (agentId: string) => ({ scope: 'wallet', agentId }) as const;
const asPlatform = { scope: 'platform' } as const;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : `not-an-HttpError: ${String(err)}`;
  }
  return 'no-error';
}

const convertBody = (over: Record<string, unknown> = {}) => ({
  contract: 'converter',
  function: 'convert',
  args: [{ token: 'play' }, { token: 'gold' }, '40'],
  intentId: 'i-1',
  ...over,
});

describe('what may be called', () => {
  it('signs a call the allowlist permits', async () => {
    const { t } = await harness();
    const out = await t.call(asWallet('orch:a'), convertBody());
    expect(out.txHash).toBe('0xhash');
    expect(t.signed).toHaveLength(1);
    expect(t.signed[0]!.to).toBe(CONV);
  });

  it('refuses a contract that is not in the registry', async () => {
    const { t } = await harness();
    expect(await codeOf(() => t.call(asWallet('orch:a'), convertBody({ contract: 'bazaar' })))).toBe(
      'unknown_contract',
    );
  });

  it('refuses a function with no entry, one for the wrong op, and a kind not listed', async () => {
    // ONE CODE FOR ALL THREE. Telling a persona which of them it was tells it
    // what other kinds of wallet are permitted to do, which is the one thing
    // the allowlist is keeping from it.
    const { t } = await harness();
    expect(await codeOf(() => t.call(asWallet('orch:a'), convertBody({ function: 'setPaused' })))).toBe(
      'function_not_allowed',
    );
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), { contract: 'converter', function: 'quote', args: [], intentId: 'x' }),
      ),
    ).toBe('function_not_allowed');
    // `orch:b` is a burner, and convert lists org and agent.
    expect(await codeOf(() => t.call(asWallet('orch:b'), convertBody()))).toBe('function_not_allowed');
  });

  it('reads a null kind as agent, for this decision and nothing else', async () => {
    // A pre-v4 wallet has no recorded kind. Reading it as `agent` at REQUEST
    // TIME is not the backfill migrate.ts forbids: nothing is written, and
    // spawns.kind still says "spawned before chain-svc recorded kinds", which
    // stays the true answer to a different question.
    const store = new Store(':memory:');
    // NULL, not omitted: this is a wallet spawned before chain-svc recorded
    // kinds at all, which is the state migrate.ts forbids backfilling.
    store.markSpawned('orch:old', '0x000000000000000000000000000000000000dddd', null);
    const { t } = await harness(undefined, { store });
    await expect(t.call(asWallet('orch:old'), convertBody())).resolves.toBeDefined();
    expect(store.walletRow('orch:old')!.kind).toBeNull();
  });

  it('refuses a frozen wallet before it signs anything', async () => {
    const { t, store } = await harness();
    store.freeze('orch:a');
    expect(await codeOf(() => t.call(asWallet('orch:a'), convertBody()))).toBe('wallet_frozen');
    expect(t.signed).toHaveLength(0);
  });

  it('refuses a platform credential', async () => {
    const { t } = await harness();
    expect(await codeOf(() => t.call(asPlatform as never, convertBody()))).toBe('wrong_scope');
  });
});

describe('arguments', () => {
  it('resolves token keys to addresses and never takes a raw one', async () => {
    const { t } = await harness();
    await t.call(asWallet('orch:a'), convertBody());
    const decoded = decodeFunctionData({ abi: CONVERTER_ABI, data: t.signed[0]!.data });
    expect((decoded.args as unknown[])[0]).toBe(PLAY);
    expect((decoded.args as unknown[])[1]).toBe(GOLD);

    expect(
      await codeOf(() => t.call(asWallet('orch:a'), convertBody({ args: [PLAY, { token: 'gold' }, '40'] }))),
    ).toBe('bad_args');
  });

  it('refuses a wire form the index rule does not allow', async () => {
    // The validator said `{"name": ...}` is a shape SOME rule takes; this index
    // takes a token key, and the refusal says so in the same detail format the
    // validator uses.
    const { t } = await harness();
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ name: 'bob' }, { token: 'gold' }, '40'] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('bad_args');
    expect(err?.detail).toBe('argument 0 (source): expected a token key');
  });

  it('resolves a name through the registry and applies the deny list', async () => {
    const { t } = await harness();
    await t.call(asWallet('orch:a'), {
      contract: 'converter',
      function: 'donate',
      args: [{ name: 'bob' }],
      intentId: 'd-1',
    });
    const decoded = decodeFunctionData({ abi: CONVERTER_ABI, data: t.signed[0]!.data });
    expect((decoded.args as unknown[])[0]).toBe(BOB);
  });

  it('applies the deny list by IDENTITY to a name argument', async () => {
    // THE DENY LIST IS ABOUT WHOM A PERSONA MAY PAY, and paying through a
    // contract call is still paying. A deny that applied to `send` and not to
    // `call` would be a deny with a documented bypass - and the bypass would be
    // the interesting half of the game.
    //
    // By IDENTITY, not by string: the deny entry names `treasury.play` and the
    // caller writes `bob`. Only resolving both and comparing addresses catches
    // that, which is the same pass sign-transfer already makes.
    const { t } = await harness([DONATE], { nameIsDenied: true });
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), {
          contract: 'converter',
          function: 'donate',
          args: [{ name: 'bob' }],
          intentId: 'deny-1',
        }),
      ),
    ).toBe('counterparty_denied');
    expect(t.signed).toHaveLength(0);
  });

  it('refuses an address parameter that has no rule, for wallet scope', async () => {
    // NOT DEFAULTED TO `any`. A default would open every address parameter of
    // every future contract the moment it was added to the allowlist - the
    // author writes one entry and gets a permission they did not write. The
    // refusal says which argument and why, so the fix is to add the rule.
    const { t } = await harness([UNRULED]);
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), {
        contract: 'converter',
        function: 'donate',
        args: [{ name: 'bob' }],
        intentId: 'u-1',
      });
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('bad_args');
    expect(err?.detail).toMatch(/argument 0 \(to\).*no addressArgs rule/);
    expect(t.signed).toHaveLength(0);
  });

  it('refuses an argument count that does not match the abi minus the intent slot', async () => {
    const { t } = await harness();
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'play' }, { token: 'gold' }] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('bad_args');
    // THREE, not four: the intentArg slot is the server's and the caller does
    // not supply it.
    expect(err?.detail).toBe('expected 3 arguments, got 2');
  });
});

describe('the intent slot', () => {
  it('fills it with the intent topic, at the index the entry named', async () => {
    const { t } = await harness();
    await t.call(asWallet('orch:a'), convertBody({ intentId: 'my-intent' }));
    const decoded = decodeFunctionData({ abi: CONVERTER_ABI, data: t.signed[0]!.data });
    const args = decoded.args as unknown[];
    expect(args).toHaveLength(4);
    // keccak256 of the intent id, the form the chain logs - which is what lets
    // the Converter's own event join the anomaly detector.
    expect(args[3]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(args[2]).toBe(40000000000000000000n);
  });

  it('refuses a caller that supplies a value for it', async () => {
    // Four arguments where the ABI has four but the caller may pass three. A
    // caller choosing the id the chain logs is choosing the join the anomaly
    // detector reads.
    const { t } = await harness();
    expect(
      await codeOf(() =>
        t.call(
          asWallet('orch:a'),
          convertBody({ args: [{ token: 'play' }, { token: 'gold' }, '40', `0x${'00'.repeat(32)}`] }),
        ),
      ),
    ).toBe('bad_args');
  });
});

describe('money', () => {
  it('applies the wallet cap when the amount is in the default token', async () => {
    // BOTH BOUNDS CAN REFUSE and both answer `over_max_per_tx`, so the code
    // alone cannot say which one fired. The DETAIL can, and which one fired is
    // the thing worth asserting: the wallet's own cap is what bounds an amount
    // in the default token, and the entry's cap is a second bound on top.
    const { t } = await harness();
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'play' }, { token: 'gold' }, '150'] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('over_max_per_tx');
    expect(err?.detail).toBe('max_per_tx is 100 PLAY');
  });

  it('applies the entry cap when the amount is in another token', async () => {
    // gold -> play: the amount is in gold, which no wallet cap is denominated
    // in. perTxCap is the only bound, and it is parsed in gold's own decimals.
    const { t } = await harness();
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '101'] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('over_max_per_tx');
    // The ENTRY's cap, named as such and denominated in the token that moved.
    expect(err?.detail).toBe("this call's per-transaction cap is 100 GOLD");
    await expect(
      t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '99'] })),
    ).resolves.toBeDefined();
  });

  it('takes a stage hold only for the default token', async () => {
    const { t, store } = await harness();
    await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '5'] }));
    expect(store.spentThisStage('orch:a', store.currentStage())).toBe(0n);

    await t.call(asWallet('orch:a'), convertBody({ intentId: 'i-2', args: [{ token: 'play' }, { token: 'gold' }, '5'] }));
    expect(store.spentThisStage('orch:a', store.currentStage())).toBe(5000000000000000000n);
  });

  it('refuses a zero amount', async () => {
    const { t } = await harness();
    expect(
      await codeOf(() => t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'play' }, { token: 'gold' }, '0'] }))),
    ).toBe('invalid_amount');
  });

  it('moves no money for an entry with no amount rule', async () => {
    // The push-only rule holding: an entry with no `amount` moves nothing FROM
    // the caller by this call, because a function that pulled funds would need
    // an allowance and this service has none to give.
    const { t, store } = await harness();
    await t.call(asWallet('orch:a'), {
      contract: 'converter',
      function: 'donate',
      args: [{ name: 'bob' }],
      intentId: 'd-1',
    });
    expect(store.spentThisStage('orch:a', store.currentStage())).toBe(0n);
  });
});

describe('per-entry counting', () => {
  it('refuses the call after the entry limit, and signs nothing', async () => {
    const { t } = await harness();
    const go = (id: string) =>
      codeOf(() => t.call(asWallet('orch:a'), convertBody({ intentId: id, args: [{ token: 'gold' }, { token: 'play' }, '1'] })));
    expect(await go('c-1')).toBe('no-error');
    expect(await go('c-2')).toBe('no-error');
    expect(await go('c-3')).toBe('over_stage_cap');
    expect(t.signed).toHaveLength(2);
  });

  it('gives the slot back when the failure precedes the broadcast', async () => {
    // A keystore that cannot load is a failure that PROVABLY precedes the
    // broadcast - nothing has reached the wire - so the reservation, the stage
    // hold and the count all come back. Without that, two failed key loads
    // would consume a persona's whole per-stage allowance for a call it never
    // made.
    const { t, store } = await harness([CONVERT], { keystoreThrows: true });
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '1'] })),
      ),
    ).not.toBe('no-error');
    expect(store.callCount('orch:a', store.currentStage(), 'converter', 'convert')).toBe(0);
    expect(store.intentCall('i-1')).toBeNull();
    store.close();
  });
});

describe('replay', () => {
  it('returns the original hash for the same call under the same id', async () => {
    const { t } = await harness();
    const first = await t.call(asWallet('orch:a'), convertBody());
    const again = await t.call(asWallet('orch:a'), convertBody());
    expect(again.txHash).toBe(first.txHash);
    // Signed ONCE. That is the whole promise of the intent id.
    expect(t.signed).toHaveLength(1);
  });

  it('refuses the same id carrying a different call', async () => {
    // Returning the first call's hash would tell this caller their SECOND call
    // had succeeded, which is the one wrong answer that looks like it worked.
    const { t } = await harness();
    await t.call(asWallet('orch:a'), convertBody());
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'play' }, { token: 'gold' }, '41'] })),
      ),
    ).toBe('invalid_request');
  });

  it('refuses the same id on a different function', async () => {
    const { t } = await harness();
    await t.call(asWallet('orch:a'), convertBody());
    expect(
      await codeOf(() =>
        t.call(asWallet('orch:a'), {
          contract: 'converter',
          function: 'donate',
          args: [{ name: 'bob' }],
          intentId: 'i-1',
        }),
      ),
    ).toBe('invalid_request');
  });
});

describe('a mined revert', () => {
  it('refuses with revert, keeps the reservation, and withholds the reason', async () => {
    const { t, store } = await harness(undefined, { reverted: true });
    let err: HttpError | undefined;
    try {
      await t.call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '1'] }));
    } catch (e) {
      err = e as HttpError;
    }
    expect(err?.code).toBe('revert');
    expect(err?.status).toBe(409);
    expect(err?.detail).toBe('the call was mined and reverted; nothing changed');

    // IT WAS MINED, so the slot stays spent. A persona can lose stage budget to
    // a paused pair, and `read` is free for anyone unsure.
    expect(store.callCount('orch:a', store.currentStage(), 'converter', 'convert')).toBe(1);
    expect(store.intentTxHash('i-1')).toBe('0xhash');
  });

  it('still emits the event, marked reverted', async () => {
    const { t, store } = await harness(undefined, { reverted: true });
    await t
      .call(asWallet('orch:a'), convertBody({ args: [{ token: 'gold' }, { token: 'play' }, '1'] }))
      .catch(() => undefined);
    const events = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    const call = events.find((e) => e.kind === 'agent.call')!;
    expect(call.status).toBe('reverted');
  });
});

describe('the agent.call event', () => {
  it('reports the names the caller used, never the addresses', async () => {
    const { t, store } = await harness();
    await t.call(asWallet('orch:a'), convertBody());
    const events = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    const call = events.find((e) => e.kind === 'agent.call')!;

    expect(call.name).toBe('orch:a');
    expect(call.contract).toBe('converter');
    expect(call.function).toBe('convert');
    expect(call.args).toEqual([{ token: 'play' }, { token: 'gold' }, '40']);
    expect(call.intent_id).toBe('i-1');
    expect(call.status).toBe('ok');
    expect(call.amount).toEqual({ value: '40', token: 'play' });
    expect(JSON.stringify(call)).not.toContain(PLAY);
  });
});

describe('admin-call', () => {
  it('signs with the treasury and needs no kind', async () => {
    const { t } = await harness();
    const out = await t.adminCall({
      contract: 'converter',
      function: 'setPair',
      args: [PLAY, GOLD, '1500000000000000000'],
      intentId: 'a-1',
    });
    expect(out.txHash).toBe('0xadminhash');
    // Nothing signed by a wallet key.
    expect(t.signed).toHaveLength(0);
  });

  it('takes raw addresses, which wallet scope may not', async () => {
    const { t } = await harness();
    await expect(
      t.adminCall({ contract: 'converter', function: 'setPair', args: [PLAY, GOLD, '1'], intentId: 'a-2' }),
    ).resolves.toBeDefined();
    expect(
      await codeOf(() =>
        t.adminCall({
          contract: 'converter',
          function: 'setPair',
          args: [{ token: 'play' }, { token: 'gold' }, '1'],
          intentId: 'a-3',
        }),
      ),
    ).toBe('bad_args');
  });

  it('refuses an entry that is not marked admin', async () => {
    // The hub's powers are written down too. Platform scope could bypass a
    // list; requiring the entry is what puts them on the record.
    const { t } = await harness();
    expect(
      await codeOf(() =>
        t.adminCall({ contract: 'converter', function: 'convert', args: [PLAY, GOLD, '1'], intentId: 'a-4' }),
      ),
    ).toBe('function_not_allowed');
  });

  it('emits hub.call', async () => {
    const { t, store } = await harness();
    await t.adminCall({ contract: 'converter', function: 'setPair', args: [PLAY, GOLD, '1'], intentId: 'a-5' });
    const events = store.dueEvents(10).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    expect(events.find((e) => e.kind === 'hub.call')).toMatchObject({
      contract: 'converter',
      function: 'setPair',
      status: 'ok',
    });
  });
});

describe('read', () => {
  it('serves a view without signing or reserving', async () => {
    const { t, store } = await harness();
    expect(
      await t.read(asWallet('orch:a'), {
        contract: 'converter',
        function: 'quote',
        args: [{ token: 'play' }, { token: 'gold' }, '40'],
      }),
    ).toEqual({ result: '40' });
    expect(t.signed).toHaveLength(0);
    expect(store.dueEvents(10)).toHaveLength(0);
  });

  it('refuses a non-read entry, and a read entry the kind is not in', async () => {
    const { t } = await harness();
    expect(
      await codeOf(() =>
        t.read(asWallet('orch:a'), { contract: 'converter', function: 'convert', args: [] }),
      ),
    ).toBe('function_not_allowed');
    expect(
      await codeOf(() =>
        t.read(asWallet('orch:b'), {
          contract: 'converter',
          function: 'quote',
          args: [{ token: 'play' }, { token: 'gold' }, '40'],
        }),
      ),
    ).toBe('function_not_allowed');
  });

  it('serves a platform caller without a kind check, with raw addresses', async () => {
    const { t } = await harness();
    expect(
      await t.read(asPlatform as never, {
        contract: 'converter',
        function: 'quote',
        args: [PLAY, GOLD, '40'],
      }),
    ).toEqual({ result: '40' });
  });
});
