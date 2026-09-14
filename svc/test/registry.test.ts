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
import { buildModules, requireContract, type Modules } from '../src/modules.ts';
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
