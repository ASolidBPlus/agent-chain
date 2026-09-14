// §1.3. THE GENERIC REGISTRY VIEW — `contracts`, `byKey`, `requireContract`.
//
// Increment 2's `Modules` was a set of NAMED SLOTS: `tokens`, `names`,
// `converter`. Every consumer knew which slot it wanted, and adding a module
// kind meant adding a slot and a branch everywhere that reads one.
//
// The call op cannot work that way - it is handed a key by a caller and must
// find the contract behind it without knowing what kind it is - so the same
// deployment now also has a FLAT view: every entry, keyed, with the ABI that
// encodes a call to it. The two views are built from one manifest pass, so a
// module that is in one and not the other is the failure this file is looking
// for.
//
// `buildModules` takes its ABI table as a parameter for the same reason it
// takes `read`: the real table is generated from a forge build, and a test that
// needed a real `Shop` contract to exercise a custom entry would be a test of
// the build, not of the registry.

import { describe, it, expect } from 'bun:test';
import type { Abi } from 'viem';
import { buildModules, requireContract, resolveToken, type Modules } from '../src/modules.ts';
import type { Deployment, DeployedModule } from '../src/chain.ts';
import { HttpError } from '../src/errors.ts';

const TREASURY = '0x0000000000000000000000000000000000000001';
const PLAY = '0x00000000000000000000000000000000000000aa';
const GOLD = '0x00000000000000000000000000000000000000bb';
const REG = '0x00000000000000000000000000000000000000cc';
const CONV = '0x00000000000000000000000000000000000000dd';
const SHOP = '0x00000000000000000000000000000000000000ee';

const fakeAbi = (name: string): Abi =>
  [{ type: 'function', name, inputs: [], outputs: [], stateMutability: 'view' }] as unknown as Abi;

const ABIS = {
  Token: fakeAbi('token'),
  NameRegistry: fakeAbi('registry'),
  Converter: fakeAbi('converter'),
  Shop: fakeAbi('shop'),
};

const meta: Record<string, { symbol: string; decimals: number }> = {
  [PLAY]: { symbol: 'PLAY', decimals: 18 },
  [GOLD]: { symbol: 'GOLD', decimals: 6 },
};

const read = async (address: string) => {
  const m = meta[address];
  if (!m) throw new Error(`no token at ${address}`);
  return m;
};

function deployment(modules: DeployedModule[]): Deployment {
  return { schema: 1, chainId: 31337, treasury: TREASURY, modules } as Deployment;
}

const token = (key: string, address: string): DeployedModule =>
  ({ kind: 'token', key, contract: 'Token', address }) as DeployedModule;
const names = (address: string): DeployedModule =>
  ({ kind: 'names', contract: 'NameRegistry', address, tld: 'play' }) as DeployedModule;
const converter = (address: string): DeployedModule =>
  ({ kind: 'converter', contract: 'Converter', address }) as DeployedModule;
const custom = (key: string, contract: string, address: string): DeployedModule =>
  ({ kind: 'contract', key, contract, address }) as DeployedModule;

const build = (modules: DeployedModule[]): Promise<Modules> =>
  buildModules(deployment(modules), read, ABIS);

describe('the flat registry', () => {
  it('holds every entry of every kind, not only the custom ones', async () => {
    // The temptation is to make `contracts` mean "custom contracts", because
    // that is the new thing. It does not: a caller asking to call `converter`
    // uses the same op and the same lookup as one calling `shop`, and a flat
    // view that omitted the typed kinds would need a second lookup path for
    // them - which is the branching this view exists to delete.
    const m = await build([
      token('play', PLAY),
      token('gold', GOLD),
      names(REG),
      converter(CONV),
      custom('shop', 'Shop', SHOP),
    ]);

    expect(m.contracts.map((c) => c.key)).toEqual(['play', 'gold', 'names', 'converter', 'shop']);
    expect(m.contracts.map((c) => c.kind)).toEqual([
      'token',
      'token',
      'names',
      'converter',
      'contract',
    ]);
  });

  it('keeps manifest order, the same order that makes tokens[0] the default', async () => {
    const m = await build([token('gold', GOLD), token('play', PLAY), custom('shop', 'Shop', SHOP)]);
    expect(m.contracts.map((c) => c.key)).toEqual(['gold', 'play', 'shop']);
    expect(m.tokens[0]!.key).toBe('gold');
  });

  it('gives names and converter their implicit keys', async () => {
    // The manifest writes no `key` for these: their kind IS their key, and §1.1
    // says so in one direction ("names and converter have the implicit keys").
    // If this view invented something else - "registry", the contract name - a
    // caller would have to know which kinds are addressed by their kind and
    // which by their key.
    const m = await build([names(REG), converter(CONV)]);
    expect([...m.byKey.keys()]).toEqual(['names', 'converter']);
  });

  it('carries the abi from the table, keyed by contract name', async () => {
    const m = await build([token('play', PLAY), custom('shop', 'Shop', SHOP)]);
    expect(m.byKey.get('play')!.abi).toBe(ABIS.Token);
    expect(m.byKey.get('shop')!.abi).toBe(ABIS.Shop);
    expect(m.byKey.get('shop')!.name).toBe('Shop');
  });

  it('refuses an entry whose abi is missing, naming the fix', async () => {
    // A deployment can outlive the ABI file: someone adds a contract, deploys
    // it, and does not regenerate. Booting anyway would mean the first call to
    // that contract fails inside viem's encoder, at request time, in front of a
    // persona - instead of at boot in front of the operator who deployed it.
    await expect(build([custom('shop', 'Bazaar', SHOP)])).rejects.toThrow(
      /no ABI for contract "Bazaar"; regenerate abi\.ts/,
    );
  });

  it('still builds the named slots the money endpoints read', async () => {
    // The flat view is IN ADDITION TO the typed one, not instead of it.
    // `defaultToken` and `requireNames` are what every money endpoint uses, and
    // they answer "which token is the default" - a question the flat view
    // cannot answer, because it is about order among tokens specifically.
    const m = await build([token('play', PLAY), names(REG), converter(CONV), custom('shop', 'Shop', SHOP)]);
    expect(m.tokens).toHaveLength(1);
    expect(m.tokens[0]!.symbol).toBe('PLAY');
    expect(m.names!.tld).toBe('play');
    expect(m.converter!.address).toBe(CONV);
  });

  it('reads symbol and decimals only for tokens', async () => {
    // `read` throws for anything that is not a token in this fixture, so a
    // build that tried to read a custom contract's symbol would fail here
    // rather than quietly return undefined.
    await expect(build([custom('shop', 'Shop', SHOP), names(REG)])).resolves.toBeDefined();
  });
});

describe('requireContract', () => {
  it('finds an entry of any kind by key', async () => {
    const m = await build([token('play', PLAY), converter(CONV), custom('shop', 'Shop', SHOP)]);
    expect(requireContract(m, 'play').address).toBe(PLAY);
    expect(requireContract(m, 'converter').address).toBe(CONV);
    expect(requireContract(m, 'shop').address).toBe(SHOP);
  });

  it('refuses an unknown key with unknown_contract', async () => {
    // 404 and persona-facing, like `unknown_name`: which contracts exist is a
    // fact about the deployment's public registry, not about the caller's
    // policy. Telling a persona "there is no such contract" leaks nothing it
    // could not learn from the `contracts` tool.
    const m = await build([token('play', PLAY)]);
    let err: unknown;
    try {
      requireContract(m, 'shop');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('unknown_contract');
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).detail).toBe('no contract "shop" in this deployment');
  });

  it('does not find a contract by its contract name', async () => {
    // Keys, never names: `Shop` is the class, `shop` is the instance, and a
    // manifest may deploy two instances of one contract under two keys. A
    // lookup that accepted either would be ambiguous exactly when it mattered.
    const m = await build([custom('shop', 'Shop', SHOP)]);
    expect(() => requireContract(m, 'Shop')).toThrow(HttpError);
  });
});

// §1. THE ONE TOKEN RESOLVER.
//
// A `token` argument may be the manifest KEY or the SYMBOL, case-insensitively,
// and the reason is not convenience: a persona reads SYMBOLS in every reply -
// balances, history entries, refusal messages - and must be able to write back
// what it read. A resolver that took only keys would answer "unknown_token" to
// the exact string the service had just shown it.
//
// ONE resolver, in modules.ts, and every caller goes through it: body or query
// string, writes or reads. Two of them would be two answers to one question the
// first time somebody added a rule to one - and the rule that matters here is
// case-insensitivity, which is exactly the kind of thing that gets added twice
// and spelled differently.
describe('resolveToken', () => {
  const twoTokens = () => build([token('play', PLAY), token('gold', GOLD), names(REG)]);

  it('finds a token by its manifest key', async () => {
    expect((await twoTokens().then((m) => resolveToken(m, 'gold'))).key).toBe('gold');
  });

  it('finds a token by its symbol', async () => {
    expect((await twoTokens().then((m) => resolveToken(m, 'GOLD'))).key).toBe('gold');
  });

  it('is case-insensitive in both namespaces', async () => {
    const m = await twoTokens();
    for (const written of ['GOLD', 'gold', 'GoLd', 'Gold']) {
      expect(resolveToken(m, written).key).toBe('gold');
    }
    // PLAY's key and symbol differ only in case, which is the ordinary shape:
    // a manifest key is lower-case and a symbol is upper-case for the same
    // token, so both spellings must land on it.
    expect(resolveToken(m, 'PLAY').key).toBe('play');
    expect(resolveToken(m, 'play').key).toBe('play');
  });

  it('prefers the KEY when one token\'s key is another\'s symbol', async () => {
    // Pathological but constructible: a manifest may key a token `gold` while
    // ANOTHER token's symbol is GOLD. The key namespace is the manifest's own
    // and is what chain-svc stores, so it wins - and the ambiguity is the
    // manifest author's to remove.
    const m = await buildModules(
      deployment([token('gold', GOLD), token('silver', PLAY)]),
      async (a) => (a === GOLD ? { symbol: 'XAU', decimals: 6 } : { symbol: 'GOLD', decimals: 18 }),
      ABIS,
    );
    expect(resolveToken(m, 'gold').key).toBe('gold');
    expect(resolveToken(m, 'GOLD').key).toBe('gold');
    expect(resolveToken(m, 'silver').key).toBe('silver');
  });

  it('resolves by SYMBOL when the symbol is not the key in another case', async () => {
    // THE TEST THE FIRST DRAFT DID NOT HAVE, found by a mutant that made the
    // symbol lookup case-sensitive and SURVIVED. Every token in the fixture
    // had a symbol that was just its key in upper case - so `GOLD` resolved
    // through the KEY path and the symbol path was never exercised at all.
    //
    // A key and a symbol that differ as WORDS is the ordinary case for a game
    // currency: the manifest keys it `au` and the contract reports `GOLD`.
    const m = await buildModules(
      deployment([token('play', PLAY), token('au', GOLD)]),
      async (a) => (a === PLAY ? { symbol: 'PLAY', decimals: 18 } : { symbol: 'GOLD', decimals: 6 }),
      ABIS,
    );
    expect(resolveToken(m, 'GOLD').key).toBe('au');
    expect(resolveToken(m, 'gold').key).toBe('au');
    expect(resolveToken(m, 'GoLd').key).toBe('au');
    expect(resolveToken(m, 'au').key).toBe('au');
    expect(resolveToken(m, 'AU').key).toBe('au');
  });

  it('returns the DEFAULT token when no token is named', async () => {
    // THE ONE RULE of this increment: a request that names no token behaves
    // exactly as it did before there were two.
    const m = await twoTokens();
    for (const absent of [undefined, null, '']) {
      expect(resolveToken(m, absent).key).toBe('play');
    }
  });

  it('refuses a name that is neither a key nor a symbol, with unknown_token', async () => {
    const m = await twoTokens();
    let err: unknown;
    try {
      resolveToken(m, 'silver');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('unknown_token');
    expect((err as HttpError).status).toBe(404);
    // The detail LISTS what exists, because the caller is a model and the whole
    // point of a persona-facing refusal is that it can fix its own call.
    expect((err as HttpError).detail).toContain('play');
    expect((err as HttpError).detail).toContain('gold');
  });

  it('refuses a non-string token as bad input, not as an unknown one', async () => {
    const m = await twoTokens();
    for (const bad of [42, true, {}, []]) {
      expect(() => resolveToken(m, bad)).toThrow(HttpError);
    }
  });

  it('answers module_not_deployed on a deployment with NO tokens', async () => {
    // TWO DIFFERENT ABSENCES, TWO CODES. "this deployment has no token module"
    // is a fact about the deployment's shape, withheld from personas; "no such
    // token" is a fact about the public registry, which they may have. A single
    // code would have made a names-only deployment tell a persona that PLAY
    // does not exist.
    const m = await build([names(REG)]);
    let err: unknown;
    try {
      resolveToken(m, 'play');
    } catch (e) {
      err = e;
    }
    expect((err as HttpError).code).toBe('module_not_deployed');
  });

  it('answers module_not_deployed for an ABSENT token on a tokenless deployment too', async () => {
    // The absent-argument path must not answer differently from the named one
    // about the same missing module.
    const m = await build([names(REG)]);
    expect(() => resolveToken(m, undefined)).toThrow(/no token module/);
  });
});
