// Deploying a manifest's modules from chain-svc, with the same result as the
// boot container: the same CREATE2 addresses, the same code, the same roles.
//
// SAME ADDRESSES BECAUSE THE SAME INPUTS. Every module is created through the
// factory the container's `new X{salt}` goes through, from the same salt and the
// same init code - creation code from bytecode.ts, which is generated from the
// same build, followed by the same constructor arguments. Measured: for
// two-tokens.json the addresses derived here equal the container's, all four.
//
// IDEMPOTENT PER MODULE. An address with no code is deployed; one whose code
// hashes to the module's runtimeHash is already there; anything else is foreign
// code at an address this manifest owns, and the deploy stops before sending.

import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { BYTECODE } from './bytecode.ts';
import { ConverterAbi, NameRegistryAbi, TokenAbi } from './abi.ts';
import { ZERO_FEES, type Chain, type Deployment } from './chain.ts';
import { HttpError } from './errors.ts';
import {
  KIND_CONTRACT,
  KIND_CONVERTER,
  KIND_NAMES,
  KIND_TOKEN,
  effectiveKey,
  parseUintLike,
  type Manifest,
  type ModuleSpec,
} from './manifest.ts';

/// The deterministic-deployment proxy anvil predeploys, and the one forge
/// routes `new X{salt}` through under broadcast.
export const CREATE2_FACTORY = getAddress('0x4e59b44847b379578588920cA78FbF26c0B4956C');

const CONTRACT_FOR_KIND: Record<string, string> = {
  [KIND_TOKEN]: 'Token',
  [KIND_NAMES]: 'NameRegistry',
  [KIND_CONVERTER]: 'Converter',
};

/// Deploy.s.sol `saltFor`: keccak256 of "kind:key", or of the bare kind for a
/// singleton that has no key.
export const saltFor = (kind: string, key?: string): Hex => keccak256(toBytes(key ? `${kind}:${key}` : kind));

export const contractOf = (m: ModuleSpec): string => (m.kind === KIND_CONTRACT ? (m.name as string) : CONTRACT_FOR_KIND[m.kind]);

/// A contract entry's arguments, as Deploy.s.sol `_encodeOneArg` packs them:
/// every supported type is one 32-byte word. `@treasury` and `@<earlier key>`
/// resolve to addresses, which is why earlier modules' addresses are needed.
function contractArgs(m: ModuleSpec, index: number, mods: ModuleSpec[], addrs: Address[], treasury: Address): Hex {
  const words: Hex[] = (m.args ?? []).map((a) => {
    if (a.type === 'address') {
      let addr: Address;
      if (a.value === '@treasury') addr = treasury;
      else if (a.value.startsWith('@')) addr = addrs[mods.slice(0, index).findIndex((x) => effectiveKey(x) === a.value.slice(1))];
      else addr = getAddress(a.value.startsWith('0x') ? a.value : `0x${a.value}`);
      return encodeAbiParameters([{ type: 'address' }], [addr]);
    }
    if (a.type === 'uint256') return encodeAbiParameters([{ type: 'uint256' }], [parseUintLike(a.value) as bigint]);
    if (a.type === 'bool') return encodeAbiParameters([{ type: 'bool' }], [a.value === 'true']);
    return (a.value.startsWith('0x') ? a.value : `0x${a.value}`) as Hex; // bytes32, already one word
  });
  return concatHex(words.length > 0 ? words : ['0x']);
}

function initcodeFor(m: ModuleSpec, index: number, mods: ModuleSpec[], addrs: Address[], treasury: Address): Hex {
  const contract = contractOf(m);
  const code = BYTECODE[contract];
  if (!code) {
    // Only a contract compiled from contracts/src ships its bytecode, so only
    // one of those can be deployed from here.
    throw new HttpError(
      'invalid_request',
      `manifest: no bytecode for contract "${contract}"; only contracts under contracts/src can be deployed this way`,
    );
  }
  let args: Hex;
  if (m.kind === KIND_TOKEN) {
    args = encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'address' }], [
      m.name as string,
      m.symbol as string,
      treasury,
    ]);
  } else if (m.kind === KIND_NAMES || m.kind === KIND_CONVERTER) {
    args = encodeAbiParameters([{ type: 'address' }], [treasury]);
  } else {
    args = contractArgs(m, index, mods, addrs, treasury);
  }
  return concatHex([code.creation, args]);
}

export interface PlannedModule {
  spec: ModuleSpec;
  contract: string;
  salt: Hex;
  initcode: Hex;
  address: Address;
  runtimeHash: Hex;
}

/// Every module's address, in manifest order. Pure: nothing is read from the
/// chain, which is what lets the pre-flight run before anything is sent.
export function deriveModules(manifest: Manifest, treasury: Address): PlannedModule[] {
  const addrs: Address[] = [];
  return manifest.modules.map((m, i) => {
    const contract = contractOf(m);
    const salt = saltFor(m.kind, m.key);
    const initcode = initcodeFor(m, i, manifest.modules, addrs, treasury);
    const address = getContractAddress({ opcode: 'CREATE2', from: CREATE2_FACTORY, salt, bytecode: initcode });
    addrs.push(address);
    return { spec: m, contract, salt, initcode, address, runtimeHash: BYTECODE[contract].runtimeHash };
  });
}

/// The record a successful deploy writes: the same shape, key for key and in
/// the same order, as the container's local.json.
export function recordFor(planned: PlannedModule[], treasury: Address, chainId: number): Deployment {
  return {
    schema: 1,
    chainId,
    treasury: getAddress(treasury),
    modules: planned.map((p) => ({
      kind: p.spec.kind,
      ...(p.spec.kind === KIND_TOKEN || p.spec.kind === KIND_CONTRACT ? { key: p.spec.key } : {}),
      contract: p.contract,
      address: getAddress(p.address),
      codehash: p.runtimeHash,
      ...(p.spec.kind === KIND_NAMES ? { tld: p.spec.tld } : {}),
    })),
  } as unknown as Deployment;
}

export type ModuleStatus = 'deployed' | 'present';

/// What is at each address now. Absent is to be deployed; the module's own code
/// is present; anything else stops the deploy by name before a transaction.
export async function statusOf(chain: Chain, planned: PlannedModule[]): Promise<ModuleStatus[]> {
  const out: ModuleStatus[] = [];
  for (const p of planned) {
    const code = await chain.publicClient.getCode({ address: p.address });
    if (code === undefined || code === '0x') {
      out.push('deployed');
    } else if (keccak256(code) === p.runtimeHash) {
      out.push('present');
    } else {
      throw new HttpError(
        'deployment_conflict',
        `${p.spec.kind}${p.spec.key ? ` "${p.spec.key}"` : ''}: ${p.address} holds code that is not ${p.contract}; nothing was sent`,
      );
    }
  }
  return out;
}

/// The two send sites. Every transaction a deploy sends goes through one of
/// them, each under the treasury's queue and each spreading ZERO_FEES.
async function sendCreate(chain: Chain, p: PlannedModule): Promise<Hex> {
  const hash = await chain.sendAsTreasury((wallet) =>
    wallet.sendTransaction({
      account: wallet.account!,
      chain: chain.viemChain,
      to: CREATE2_FACTORY,
      data: concatHex([p.salt, p.initcode]),
      ...ZERO_FEES,
    }),
  );
  await confirm(chain, hash, `deploying ${p.contract}`);
  return hash;
}

async function sendCall(
  chain: Chain,
  address: Address,
  abi: typeof TokenAbi | typeof NameRegistryAbi | typeof ConverterAbi,
  functionName: string,
  args: readonly unknown[],
): Promise<Hex> {
  const hash = await chain.sendAsTreasury((wallet) =>
    wallet.writeContract({
      account: wallet.account!,
      chain: chain.viemChain,
      address,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
      ...ZERO_FEES,
    }),
  );
  await confirm(chain, hash, functionName);
  return hash;
}

async function confirm(chain: Chain, hash: Hex, what: string): Promise<void> {
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new HttpError('revert', `${what} reverted (${hash})`);
}

const read = <T>(chain: Chain, address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) =>
  chain.publicClient.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;

/// Sends what is missing, in Deploy.s.sol's order, and nothing that is not.
///
/// `recordExists` gates A8's one addition: after a crash between a token's
/// creation and its seed, the token is present with no supply and no record was
/// written. Only then is a present token minted; a token with any supply never is.
export async function sendDeployment(
  chain: Chain,
  manifest: Manifest,
  planned: PlannedModule[],
  status: ModuleStatus[],
  treasury: Address,
  recordExists: boolean,
): Promise<Hex[]> {
  const txs: Hex[] = [];
  for (let i = 0; i < planned.length; i++) {
    const p = planned[i];
    if (status[i] === 'deployed') txs.push(await sendCreate(chain, p));

    if (p.spec.kind === KIND_TOKEN && (p.spec.initialSupply ?? 0n) > 0n) {
      const created = status[i] === 'deployed';
      const unseeded =
        !created && !recordExists && (await read<bigint>(chain, p.address, TokenAbi, 'totalSupply')) === 0n;
      if (created || unseeded) {
        const amount = (p.spec.initialSupply as bigint) * 10n ** 18n;
        txs.push(await sendCall(chain, p.address, TokenAbi, 'mint', [treasury, amount]));
        // THE SEED CHECK, right after the mint it is a post-condition of - the
        // same place the container asserts it.
        const held = await read<bigint>(chain, p.address, TokenAbi, 'balanceOf', [treasury]);
        if (held !== amount) throw new HttpError('deployment_failed', 'treasury was not seeded');
      }
    }
  }

  const tokenAt = (key: string): Address => planned[manifest.modules.findIndex((m) => m.kind === KIND_TOKEN && m.key === key)].address;
  const names = planned.find((p) => p.spec.kind === KIND_NAMES);
  const converter = planned.find((p) => p.spec.kind === KIND_CONVERTER);
  const haveToken = manifest.modules.some((m) => m.kind === KIND_TOKEN);

  if (names && haveToken) {
    const treasuryName = `treasury.${names.spec.tld}`;
    const resolved = await read<Address>(chain, names.address, NameRegistryAbi, 'resolve', [treasuryName]);
    if (resolved === '0x0000000000000000000000000000000000000000') {
      txs.push(await sendCall(chain, names.address, NameRegistryAbi, 'registerFor', [treasuryName, treasury, treasury]));
    }
  }

  if (converter) {
    for (const pair of manifest.pairs) {
      const src = tokenAt(pair.source);
      const tgt = tokenAt(pair.target);
      // An existing pair is LEFT AS IS, even at a different rate. The container
      // re-sends every pair on every run; the route sends only what is missing,
      // so on a fresh chain the two send the same transactions.
      const [, , exists] = await read<readonly [bigint, bigint, boolean]>(chain, converter.address, ConverterAbi, 'pair', [src, tgt]);
      if (!exists) txs.push(await sendCall(chain, converter.address, ConverterAbi, 'setPair', [src, tgt, pair.rate]));
      const burner = await read<Hex>(chain, src, TokenAbi, 'BURNER_ROLE');
      if (!(await read<boolean>(chain, src, TokenAbi, 'hasRole', [burner, converter.address]))) {
        txs.push(await sendCall(chain, src, TokenAbi, 'grantRole', [burner, converter.address]));
      }
      const minter = await read<Hex>(chain, tgt, TokenAbi, 'MINTER_ROLE');
      if (!(await read<boolean>(chain, tgt, TokenAbi, 'hasRole', [minter, converter.address]))) {
        txs.push(await sendCall(chain, tgt, TokenAbi, 'grantRole', [minter, converter.address]));
      }
    }
  }
  return txs;
}

/// Deploy.s.sol `_assertDeployment`, the same roles and wiring, read back from
/// the chain after the sends. A failure names the assertion and writes nothing.
export async function assertDeployment(chain: Chain, manifest: Manifest, planned: PlannedModule[], treasury: Address): Promise<void> {
  const fail = (what: string): never => {
    throw new HttpError('deployment_failed', what);
  };
  const ZERO = '0x0000000000000000000000000000000000000000' as Address;
  const converter = planned.find((p) => p.spec.kind === KIND_CONVERTER)?.address;
  const haveToken = manifest.modules.some((m) => m.kind === KIND_TOKEN);
  const has = (addr: Address, abi: unknown, role: Hex, who: Address) => read<boolean>(chain, addr, abi, 'hasRole', [role, who]);
  const role = (addr: Address, abi: unknown, name: string) => read<Hex>(chain, addr, abi, name);

  for (const p of planned) {
    const a = p.address;
    if (p.spec.kind === KIND_TOKEN) {
      const admin = await role(a, TokenAbi, 'DEFAULT_ADMIN_ROLE');
      const freezer = await role(a, TokenAbi, 'FREEZER_ROLE');
      if (!(await has(a, TokenAbi, await role(a, TokenAbi, 'MINTER_ROLE'), treasury))) fail('treasury lacks MINTER_ROLE');
      if (!(await has(a, TokenAbi, freezer, treasury))) fail('treasury lacks FREEZER_ROLE');
      if (await has(a, TokenAbi, await role(a, TokenAbi, 'BURNER_ROLE'), treasury)) fail('treasury must not hold BURNER_ROLE');
      if (converter && (await has(a, TokenAbi, freezer, converter))) fail('converter must not hold FREEZER_ROLE');
      if (!(await has(a, TokenAbi, admin, treasury))) fail('treasury lacks DEFAULT_ADMIN_ROLE');
      if (await has(a, TokenAbi, admin, ZERO)) fail('address(0) must not hold DEFAULT_ADMIN_ROLE');
      if (converter && (await has(a, TokenAbi, admin, converter))) fail('converter must not hold DEFAULT_ADMIN_ROLE');
    } else if (p.spec.kind === KIND_NAMES) {
      const admin = await role(a, NameRegistryAbi, 'DEFAULT_ADMIN_ROLE');
      if (!(await has(a, NameRegistryAbi, await role(a, NameRegistryAbi, 'REGISTRAR_ROLE'), treasury))) fail('treasury lacks REGISTRAR_ROLE');
      if (!(await has(a, NameRegistryAbi, admin, treasury))) fail('treasury lacks DEFAULT_ADMIN_ROLE');
      if (await has(a, NameRegistryAbi, admin, ZERO)) fail('address(0) must not hold DEFAULT_ADMIN_ROLE');
      if (converter && (await has(a, NameRegistryAbi, admin, converter))) fail('converter must not hold DEFAULT_ADMIN_ROLE on the registry');
      if (haveToken && (await read<Address>(chain, a, NameRegistryAbi, 'resolve', [`treasury.${p.spec.tld}`])).toLowerCase() !== treasury.toLowerCase()) {
        fail('treasury name does not resolve');
      }
    } else if (p.spec.kind === KIND_CONVERTER) {
      const admin = await role(a, ConverterAbi, 'DEFAULT_ADMIN_ROLE');
      const rate = await role(a, ConverterAbi, 'RATE_ADMIN_ROLE');
      if (!(await has(a, ConverterAbi, admin, treasury))) fail('treasury lacks DEFAULT_ADMIN_ROLE');
      if (!(await has(a, ConverterAbi, rate, treasury))) fail('treasury lacks RATE_ADMIN_ROLE');
      if (await has(a, ConverterAbi, admin, ZERO)) fail('address(0) must not hold DEFAULT_ADMIN_ROLE');
      if (await has(a, ConverterAbi, rate, ZERO)) fail('address(0) must not hold RATE_ADMIN_ROLE');
      for (const pair of manifest.pairs) {
        const src = planned[manifest.modules.findIndex((m) => m.kind === KIND_TOKEN && m.key === pair.source)].address;
        const tgt = planned[manifest.modules.findIndex((m) => m.kind === KIND_TOKEN && m.key === pair.target)].address;
        const [, , exists] = await read<readonly [bigint, bigint, boolean]>(chain, a, ConverterAbi, 'pair', [src, tgt]);
        if (!exists) fail('converter pair was not set');
        if (!(await has(src, TokenAbi, await role(src, TokenAbi, 'BURNER_ROLE'), a))) fail('converter lacks BURNER_ROLE on a source token');
        if (!(await has(tgt, TokenAbi, await role(tgt, TokenAbi, 'MINTER_ROLE'), a))) fail('converter lacks MINTER_ROLE on a target token');
      }
    } else {
      const code = await chain.publicClient.getCode({ address: a });
      if (code === undefined || code === '0x') fail('contract has no code');
    }
  }
}
