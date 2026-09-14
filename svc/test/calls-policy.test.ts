// §8.2. `calls.json` — the allowlist, and every way it can be wrong.
//
// THE FILE IS THE WHOLE SECURITY BOUNDARY of the generic call op. Everything a
// persona may do on chain beyond `send` is in it, and it is hub-set: written
// into a bind-mounted directory by whoever runs the scenario, edited between
// turns, never reviewed by anyone reading this code. So the loader is written
// to fail CLOSED in every direction and this file is the evidence, one test per
// way it can be wrong.
//
// FAIL CLOSED HAS A SPECIFIC MEANING HERE and it is why a malformed file does
// not merely log: a broken allowlist must not OPEN anything. A loader that
// dropped the entries it could not parse and kept the rest would turn a typo in
// one entry into a silent widening of every other, and a loader that threw at
// boot would make a scenario's typo take the whole service down. The middle is
// the only safe place: the op is closed, the service runs, and the log says so.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Abi } from 'viem';
import { CallPolicy } from '../src/calls.ts';
import { buildModules, type Modules } from '../src/modules.ts';
import type { Deployment } from '../src/chain.ts';

const TREASURY = '0x0000000000000000000000000000000000000001';
const PLAY = '0x00000000000000000000000000000000000000aa';
const GOLD = '0x00000000000000000000000000000000000000bb';
const CONV = '0x00000000000000000000000000000000000000dd';
const SHOP = '0x00000000000000000000000000000000000000ee';

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
  fn('tip', [{ type: 'address', name: 'to' }], 'payable'),
  fn('overloaded', [{ type: 'uint256', name: 'a' }], 'nonpayable'),
  fn('overloaded', [{ type: 'address', name: 'a' }], 'nonpayable'),
  fn('exotic', [{ type: 'function', name: 'f' }], 'nonpayable'),
] as unknown as Abi;

const SHOP_ABI = [
  fn(
    'buy',
    [
      { type: 'uint256', name: 'sku' },
      { type: 'uint256', name: 'price' },
    ],
    'nonpayable',
  ),
] as unknown as Abi;

const ABIS = { Token: [] as unknown as Abi, Converter: CONVERTER_ABI, Shop: SHOP_ABI };

let dir: string;
let logged: string[];

async function registry(): Promise<Modules> {
  const deployment = {
    schema: 1,
    chainId: 31337,
    treasury: TREASURY,
    modules: [
      { kind: 'token', key: 'play', contract: 'Token', address: PLAY },
      { kind: 'token', key: 'gold', contract: 'Token', address: GOLD },
      { kind: 'converter', contract: 'Converter', address: CONV },
      { kind: 'contract', key: 'shop', contract: 'Shop', address: SHOP },
    ],
  } as unknown as Deployment;

  const meta: Record<string, { symbol: string; decimals: number }> = {
    [PLAY]: { symbol: 'PLAY', decimals: 18 },
    [GOLD]: { symbol: 'GOLD', decimals: 6 },
  };
  return buildModules(deployment, async (a) => meta[a]!, ABIS);
}

const write = (body: unknown) =>
  writeFileSync(join(dir, 'calls.json'), typeof body === 'string' ? body : JSON.stringify(body));

async function policy(): Promise<CallPolicy> {
  return new CallPolicy(dir, await registry(), (line) => logged.push(line));
}

/// The entries a good file yields, so each refusal test can say "this one line
/// is what makes it bad".
const CONVERT = {
  contract: 'converter',
  function: 'convert',
  kinds: ['org', 'agent'],
  amount: { arg: 2, token: { arg: 0 } },
  // The {arg} form carries a bound because it MIGHT resolve to a non-default
  // token: `play -> gold` is bounded by max_per_tx, `gold -> play` by nothing
  // the wallet holds. Decided from the entry's shape, so the operator meets it
  // when they write the file.
  perTxCap: '100',
  intentArg: 3,
  maxPerStage: 20,
  addressArgs: { '0': 'token', '1': 'token' },
};
const QUOTE = { contract: 'converter', function: 'quote', read: true, kinds: ['org', 'agent', 'burner'] };
const SET_PAIR = { contract: 'converter', function: 'setPair', admin: true };
const BUY = {
  contract: 'shop',
  function: 'buy',
  kinds: ['agent'],
  amount: { arg: 1, token: 'gold' },
  perTxCap: '50',
  maxPerStage: 5,
};
const GOOD = { schema: 1, calls: [CONVERT, QUOTE, SET_PAIR, BUY] };

/// One entry, plus whatever is needed to make the FILE valid. Each refusal test
/// varies exactly one thing.
const only = (entry: unknown) => ({ schema: 1, calls: [entry] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'calls-policy-'));
  logged = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('an absent file', () => {
  it('is an empty allowlist, and says so once', async () => {
    // NOT AN ERROR. Every scenario that does not use the call op has no
    // calls.json, which is most of them, and a deployment that refused to boot
    // without one would make the op mandatory rather than available.
    const p = await policy();
    const list = p.snapshot();
    expect(list.entries).toHaveLength(0);
    expect(list.find('converter', 'convert')).toBeUndefined();
    expect(logged.join('\n')).toMatch(/calls\.json: none at .*calls\.json; the generic call op is closed/);
  });
});

describe('a malformed file', () => {
  it('closes the op and logs the line, rather than opening part of it', async () => {
    write('{ not json');
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/calls\.json/);
  });

  it('refuses a wrong schema, an absent calls array, and a non-object entry', async () => {
    for (const bad of [
      { schema: 2, calls: [] },
      { schema: 1 },
      { schema: 1, calls: {} },
      { schema: 1, calls: [null] },
      { schema: 1, calls: ['convert'] },
    ]) {
      write(bad);
      const p = await policy();
      expect(p.snapshot().entries).toHaveLength(0);
    }
  });
});

describe('a valid file', () => {
  it('parses every entry and finds them by (contract, function)', async () => {
    write(GOOD);
    const list = (await policy()).snapshot();
    expect(list.entries).toHaveLength(4);

    const convert = list.find('converter', 'convert')!;
    expect(convert.kinds).toEqual(['org', 'agent']);
    expect(convert.amount).toEqual({ arg: 2, token: { arg: 0 } });
    expect(convert.intentArg).toBe(3);
    expect(convert.maxPerStage).toBe(20);
    expect(convert.addressArgs).toEqual({ 0: 'token', 1: 'token' });
    expect(convert.read).toBe(false);
    expect(convert.admin).toBe(false);

    expect(list.find('converter', 'quote')!.read).toBe(true);
    expect(list.find('converter', 'setPair')!.admin).toBe(true);
    expect(list.find('shop', 'buy')!.perTxCap).toBe('50');
  });

  it('carries the resolved ABI fragment, so nothing re-looks-it-up later', async () => {
    write(GOOD);
    const convert = (await policy()).snapshot().find('converter', 'convert')!;
    expect(convert.abiFunction.inputs.map((i) => i.type)).toEqual([
      'address',
      'address',
      'uint256',
      'bytes32',
    ]);
  });

  it('does not find a function that has no entry', async () => {
    // THE DEFAULT IS CLOSED. `setPaused` is on the contract and in the ABI; it
    // is not in the file, so it is not callable by anyone.
    write(GOOD);
    expect((await policy()).snapshot().find('converter', 'setPaused')).toBeUndefined();
  });
});

describe('an entry the registry contradicts', () => {
  it('refuses an unknown contract key', async () => {
    write(only({ ...CONVERT, contract: 'bazaar' }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/no contract "bazaar"/);
  });

  it('refuses a function the contract does not have', async () => {
    write(only({ ...CONVERT, function: 'teleport' }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/"teleport" is not a function of converter/);
  });

  it('refuses an overloaded function by name', async () => {
    // Two functions share the name, so `{"function": "overloaded"}` does not
    // identify one. Picking either would encode a call the author did not mean,
    // and the two differ in ARGUMENT TYPES, which is exactly what the validator
    // and the caps read.
    write(only({ contract: 'converter', function: 'overloaded', kinds: ['agent'] }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/"overloaded" is overloaded in converter; not supported/);
  });

  it('refuses a parameter type the validator cannot check', async () => {
    // At LOAD, never at call time: an unsupported type is a fact about the
    // file, and finding it when the file loads means the operator sees it
    // instead of a persona meeting a 500.
    write(only({ contract: 'converter', function: 'exotic', kinds: ['agent'] }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/unsupported parameter type/);
  });
});

describe('state mutability', () => {
  it('refuses read: true on a function that is not view or pure', async () => {
    write(only({ contract: 'converter', function: 'convert', read: true, kinds: ['agent'] }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/"convert" is not view or pure/);
  });

  it('refuses a view function as a call entry', async () => {
    // The mirror image, and it matters for the same reason: a view served
    // through `call` would reserve an intent, spend stage budget and sign a
    // transaction to learn something `read` answers for free.
    write(only({ contract: 'converter', function: 'quote', kinds: ['agent'] }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/"quote" is view; it needs "read": true/);
  });

  it('refuses a payable function outright, read or not', async () => {
    for (const entry of [
      { contract: 'converter', function: 'tip', kinds: ['agent'] },
      { contract: 'converter', function: 'tip', kinds: ['agent'], admin: true },
    ]) {
      write(only(entry));
      const p = await policy();
      expect(p.snapshot().entries).toHaveLength(0);
      expect(logged.join('\n')).toMatch(
        /payable functions are not callable; the chain has no ETH economy/,
      );
    }
  });
});

describe('kinds and admin', () => {
  it('refuses a kind that is not a wallet kind', async () => {
    write(only({ ...CONVERT, kinds: ['org', 'wizard'] }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/"wizard" is not a wallet kind/);
  });

  it('refuses an empty kinds list on an entry that is not admin-only', async () => {
    // An entry no kind may call and the hub may not call either is not a
    // narrow permission, it is a line that does nothing - and a file whose
    // author believed it did something.
    write(only({ ...CONVERT, kinds: [] }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
  });

  it('accepts an admin-only entry with no kinds at all', async () => {
    write(only(SET_PAIR));
    const list = (await policy()).snapshot();
    expect(list.find('converter', 'setPair')!.kinds).toEqual([]);
    expect(list.find('converter', 'setPair')!.admin).toBe(true);
  });

  it('accepts an entry that is both callable and admin-callable', async () => {
    write(only({ ...SET_PAIR, kinds: ['org'] }));
    const entry = (await policy()).snapshot().find('converter', 'setPair')!;
    expect(entry.admin).toBe(true);
    expect(entry.kinds).toEqual(['org']);
  });
});

describe('amount', () => {
  it('refuses an amount arg that is not a uint256', async () => {
    write(only({ ...CONVERT, amount: { arg: 0, token: 'play' } }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/amount\.arg 0 is address, not uint256/);
  });

  it('refuses an amount arg index that is out of range', async () => {
    write(only({ ...CONVERT, amount: { arg: 9, token: 'play' } }));
    expect((await policy()).snapshot().entries).toHaveLength(0);
  });

  it('refuses an amount token key the registry does not have', async () => {
    write(only({ ...CONVERT, amount: { arg: 2, token: 'silver' } }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/silver/);
  });

  it('refuses an amount token key that is not a TOKEN', async () => {
    // `shop` is in the registry and is not money. An amount denominated in a
    // contract has no decimals to parse with and no cap to check against.
    write(only({ ...CONVERT, amount: { arg: 2, token: 'shop' } }));
    expect((await policy()).snapshot().entries).toHaveLength(0);
  });

  it('refuses a token: {arg} that does not point at an address parameter', async () => {
    write(only({ ...CONVERT, amount: { arg: 2, token: { arg: 2 } } }));
    expect((await policy()).snapshot().entries).toHaveLength(0);
  });

  it('requires perTxCap or uncapped for an amount in a non-default token', async () => {
    // §3.2 step 6: increment 3 has no per-wallet per-token caps, so the entry
    // carries the only bound there is. WITHOUT ONE, an agent could move any
    // quantity of a non-default token through a call while its `max_per_tx` -
    // which is denominated in the default token - looked on.
    const { perTxCap: _dropped, ...noCap } = BUY;
    write(only(noCap));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/needs "perTxCap" or "uncapped"/);
  });

  it('requires perTxCap or uncapped on the {arg} form, whatever it resolves to', async () => {
    // THE HOLE THE SPEC'S OWN EXAMPLE WALKED THROUGH. `token: {arg: 0}` means
    // "the token whose address is argument 0", chosen per call: for
    // `convert(source, target, amountIn)`, `play -> gold` puts the amount in
    // the default token and max_per_tx bounds it, while `gold -> play` puts it
    // in gold, which NOTHING bounds - every wallet cap is denominated in the
    // default token. So the bound is required from the entry's SHAPE, and the
    // operator meets it when they write the file rather than a persona meeting
    // it mid-game converting the wrong way round.
    const { perTxCap: _dropped, ...noCap } = CONVERT;
    write(only(noCap));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/needs "perTxCap" or "uncapped"/);

    write(only({ ...noCap, uncapped: true }));
    expect((await policy()).snapshot().entries).toHaveLength(1);
  });

  it('accepts uncapped: true as the written-out alternative', async () => {
    const { perTxCap: _dropped, ...noCap } = BUY;
    write(only({ ...noCap, uncapped: true }));
    expect((await policy()).snapshot().find('shop', 'buy')!.uncapped).toBe(true);
  });

  it('does not require perTxCap when the amount is in the default token', async () => {
    // `play` is tokens[0]. The wallet's own max_per_tx and stage cap are
    // denominated in it, so the existing caps already bound this.
    write(only({ ...BUY, amount: { arg: 1, token: 'play' }, perTxCap: undefined }));
    expect((await policy()).snapshot().entries).toHaveLength(1);
  });

  it('refuses a perTxCap that is not a whole-unit amount', async () => {
    for (const cap of ['', 'lots', '-5', 5, '5.5e3']) {
      write(only({ ...BUY, perTxCap: cap }));
      expect((await policy()).snapshot().entries).toHaveLength(0);
    }
  });

  it('refuses perTxCap and uncapped together', async () => {
    // Two bounds, one of which says there is none. Whichever the code happened
    // to read first would be the rule, and the file would not say which.
    write(only({ ...BUY, uncapped: true }));
    expect((await policy()).snapshot().entries).toHaveLength(0);
  });
});

describe('intentArg', () => {
  it('refuses an intentArg that is not a bytes32 parameter', async () => {
    write(only({ ...CONVERT, intentArg: 2 }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/intentArg 2 is uint256, not bytes32/);
  });

  it('refuses an intentArg index that is out of range', async () => {
    write(only({ ...CONVERT, intentArg: 9 }));
    expect((await policy()).snapshot().entries).toHaveLength(0);
  });

  it('refuses an intentArg on a read entry', async () => {
    // A read signs nothing and reserves no intent, so there is no intent id to
    // inject. An entry asking for one is an author who thinks a read is a call.
    write(only({ ...QUOTE, intentArg: 0 }));
    expect((await policy()).snapshot().entries).toHaveLength(0);
  });
});

describe('addressArgs', () => {
  it('refuses a rule on an index that is not an address', async () => {
    write(only({ ...CONVERT, addressArgs: { '2': 'token' } }));
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(0);
    expect(logged.join('\n')).toMatch(/addressArgs 2 is uint256, not address/);
  });

  it('refuses a rule that is not one of the four', async () => {
    write(only({ ...CONVERT, addressArgs: { '0': 'wallet' } }));
    expect((await policy()).snapshot().entries).toHaveLength(0);
  });

  it('refuses a non-integer index', async () => {
    write(only({ ...CONVERT, addressArgs: { x: 'token' } }));
    expect((await policy()).snapshot().entries).toHaveLength(0);
  });

  it('accepts an entry with no addressArgs at all', async () => {
    // Not an error at load: the entry is simply uncallable by wallet scope for
    // its address parameters, which §3.2 step 5 refuses per call. `admin: true`
    // entries genuinely need no rules, because platform passes raw addresses.
    write(only(SET_PAIR));
    expect((await policy()).snapshot().entries).toHaveLength(1);
  });
});

describe('maxPerStage', () => {
  it('refuses zero, a negative, and a non-integer', async () => {
    for (const bad of [0, -1, 1.5, '20', null]) {
      write(only({ ...CONVERT, maxPerStage: bad }));
      expect((await policy()).snapshot().entries).toHaveLength(0);
    }
  });

  it('accepts an entry without one, meaning no per-entry limit', async () => {
    const { maxPerStage: _dropped, ...noLimit } = CONVERT;
    write(only(noLimit));
    expect((await policy()).snapshot().find('converter', 'convert')!.maxPerStage).toBeUndefined();
  });
});

// §7 / §2. THE WARNING THAT EXISTS BECAUSE OF WHERE THE ALLOW LIST IS MATCHED.
//
// A call that moves the default token goes through `enforcePolicy` with the
// CONTRACT KEY as the counterparty, so a kind whose allow list is not ["*"]
// must name every contract its callers may pay through. `agent` and `burner`
// carry ["*.{tld}"], which no contract key matches - which is why
// policy-defaults.json names `converter` explicitly, and why an entry naming
// something else is worth saying out loud at load.
//
// A WARNING AND NOT A REFUSAL, and that is load-bearing: the defaults are one
// of TWO sources, and the other - a per-scenario policy override, which
// REPLACES the defaults rather than extending them - cannot be seen from here
// at all. Refusing on a defaults miss would close the op for a deployment whose
// per-wallet policies are perfectly correct.
describe('the allow-list warning', () => {
  const DEFAULTS = {
    org: { max_per_tx: '1000', max_per_stage: '5000', allow: ['*'], deny: [] },
    agent: { max_per_tx: '100', max_per_stage: '500', allow: ['*.play', 'converter'], deny: [] },
    burner: { max_per_tx: '50', max_per_stage: '200', allow: ['*.play'], deny: [] },
  } as never;

  const withDefaults = async () =>
    new CallPolicy(dir, await registry(), (line) => logged.push(line), DEFAULTS);

  it('says so when a kind cannot pay through the contract it may call', async () => {
    // `burner` has ["*.play"], which does not match `converter`.
    write(only({ ...CONVERT, kinds: ['agent', 'burner'], amount: { arg: 2, token: 'play' } }));
    const p = await withDefaults();
    expect(p.snapshot().entries).toHaveLength(1);
    expect(logged.join('\n')).toMatch(
      /burner's default allow list does not name "converter"/,
    );
  });

  it('says nothing when every kind\'s defaults name it', async () => {
    write(only({ ...CONVERT, kinds: ['org', 'agent'], amount: { arg: 2, token: 'play' } }));
    await withDefaults();
    expect(logged.join('\n')).not.toMatch(/does not name/);
  });

  it('says nothing for an entry that moves no money', async () => {
    // No amount, nothing to enforce a policy against: the allow list is never
    // consulted, so naming it would be noise about a rule that does not apply.
    const { amount: _none, perTxCap: _cap, ...noMoney } = CONVERT;
    write(only({ ...noMoney, kinds: ['burner'] }));
    await withDefaults();
    expect(logged.join('\n')).not.toMatch(/does not name/);
  });

  it('says nothing for an amount in a token that is not the default', async () => {
    // Only a default-token amount reaches enforcePolicy at all; the rest are
    // bounded by the entry's own perTxCap.
    write(only({ ...BUY, kinds: ['burner'] }));
    await withDefaults();
    expect(logged.join('\n')).not.toMatch(/does not name/);
  });

  it('warns but still LOADS the entry', async () => {
    // The op stays open. A per-wallet policy may name the contract even when
    // the kind defaults do not, and this side cannot see those files.
    write(only({ ...CONVERT, kinds: ['burner'], amount: { arg: 2, token: 'play' } }));
    expect((await withDefaults()).snapshot().entries).toHaveLength(1);
  });
});

describe('the mtime cache', () => {
  it('re-reads the file when it changes', async () => {
    // A scenario rewrites calls.json between turns. Caching by mtime is what
    // makes that cheap; noticing the change is what makes it correct.
    write(GOOD);
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(4);

    write(only(QUOTE));
    // Same-second writes: mtime is bumped explicitly so the test is about the
    // cache, not about the filesystem's timestamp resolution.
    utimesSync(join(dir, 'calls.json'), new Date(), new Date(Date.now() + 2000));
    expect(p.snapshot().entries).toHaveLength(1);
  });

  it('does not re-parse an unchanged file', async () => {
    write(GOOD);
    const p = await policy();
    const first = p.snapshot();
    expect(p.snapshot()).toBe(first);
  });

  it('closes the op when a good file is replaced by a broken one', async () => {
    // The dangerous direction: an allowlist that was open stays open on a
    // parse failure, because the last good snapshot is still in hand. It must
    // not - an edit that breaks the file is exactly when an author believes
    // they have CHANGED the rules.
    write(GOOD);
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(4);

    write('{ broken');
    utimesSync(join(dir, 'calls.json'), new Date(), new Date(Date.now() + 2000));
    expect(p.snapshot().entries).toHaveLength(0);
  });

  it('closes the op when the file is deleted', async () => {
    write(GOOD);
    const p = await policy();
    expect(p.snapshot().entries).toHaveLength(4);

    rmSync(join(dir, 'calls.json'));
    expect(p.snapshot().entries).toHaveLength(0);
  });
});

describe('one snapshot per request', () => {
  it('serves every check in a request from the object it was handed', async () => {
    // §2: a reload mid-request must not apply one version to the kind check and
    // another to the caps. The snapshot is a VALUE, so holding it is the whole
    // mechanism - this asserts it is not a live view onto the file.
    write(GOOD);
    const p = await policy();
    const held = p.snapshot();

    write(only(QUOTE));
    utimesSync(join(dir, 'calls.json'), new Date(), new Date(Date.now() + 2000));

    expect(held.entries).toHaveLength(4);
    expect(held.find('converter', 'convert')).toBeDefined();
    expect(p.snapshot().entries).toHaveLength(1);
  });
});
