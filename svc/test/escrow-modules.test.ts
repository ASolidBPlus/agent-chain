// The escrow and judgehook kinds in chain-svc: the record loader, the module
// registry, and the route's planning and grants. The real-chain comparison with
// the container is scripts/verify-admin-deploy.ts on deployments/cases/escrow.json.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { concatHex, encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from 'viem';
import { validateDeployment } from '../src/chain.ts';
import { buildModules } from '../src/modules.ts';
import { BYTECODE } from '../src/bytecode.ts';
import { deriveModules, recordFor, sendDeployment, type ModuleStatus } from '../src/deploy.ts';
import { parseManifestText, readManifest } from '../src/manifest.ts';
import type { Chain } from '../src/chain.ts';
import { treasurySender } from './support/treasury.ts';

const TREASURY = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const MANIFEST = readManifest(
  parseManifestText(readFileSync(join(import.meta.dir, '../../deployments/cases/escrow.json'), 'utf8')),
);

const record = (extra: Record<string, unknown>[]) => ({
  schema: 1,
  chainId: 31337,
  treasury: TREASURY,
  modules: [
    { kind: 'token', key: 'play', contract: 'Token', address: '0x0000000000000000000000000000000000000001' },
    { kind: 'names', contract: 'NameRegistry', address: '0x0000000000000000000000000000000000000002', tld: 'play' },
    ...extra,
  ],
});
const ESCROW = { kind: 'escrow', contract: 'Escrow', address: '0x0000000000000000000000000000000000000003' as Address };
const HOOK = { kind: 'judgehook', contract: 'JudgeHook', address: '0x0000000000000000000000000000000000000004' as Address };

describe('a record with escrow and judgehook', () => {
  it('loads, and each is reachable by its kind with its own ABI', async () => {
    const deployment = validateDeployment(record([ESCROW, HOOK]), 'local.json');
    const modules = await buildModules(deployment, async () => ({ symbol: 'PLAY', decimals: 18 }));
    const fns = (key: string) =>
      (modules.byKey.get(key)?.abi ?? []).filter((x) => x.type === 'function').map((x) => (x as { name: string }).name);
    expect(modules.byKey.get('escrow')?.address).toBe(ESCROW.address);
    expect(fns('escrow')).toEqual(expect.arrayContaining(['create', 'complete', 'refund', 'get']));
    expect(modules.byKey.get('judgehook')?.address).toBe(HOOK.address);
    expect(fns('judgehook')).toContain('check');
  });

  it('refuses one naming the wrong contract', () => {
    expect(() => validateDeployment(record([{ ...ESCROW, contract: 'Token' }]), 'local.json')).toThrow(
      'is "Token", expected "Escrow"',
    );
  });

  it('refuses two of either', () => {
    expect(() => validateDeployment(record([ESCROW, ESCROW]), 'local.json')).toThrow('duplicate key "escrow"');
    expect(() => validateDeployment(record([HOOK, HOOK]), 'local.json')).toThrow('duplicate key "judgehook"');
  });

  it('refuses a contract entry keyed like the singleton', () => {
    const squat = { kind: 'contract', key: 'escrow', contract: 'Token', address: '0x0000000000000000000000000000000000000005' };
    expect(() => validateDeployment(record([ESCROW, squat]), 'local.json')).toThrow('duplicate key "escrow"');
  });
});

describe('planning escrow and judgehook', () => {
  const planned = deriveModules(MANIFEST, TREASURY);
  const names = planned.find((p) => p.spec.kind === 'names')!;

  it('builds both against the names module, not the treasury', () => {
    const arg = encodeAbiParameters([{ type: 'address' }], [names.address]);
    for (const [kind, contract] of [['escrow', 'Escrow'], ['judgehook', 'JudgeHook']] as const) {
      const p = planned.find((x) => x.spec.kind === kind)!;
      expect(p.contract).toBe(contract);
      expect(p.salt).toBe(keccak256(toBytes(kind)));
      expect(p.initcode).toBe(concatHex([BYTECODE[contract].creation, arg]));
    }
  });

  it('records them with no key and no tld', () => {
    const r = recordFor(planned, TREASURY, 31337) as unknown as { modules: Record<string, unknown>[] };
    expect(r.modules.slice(4).map((m) => Object.keys(m))).toEqual([
      ['kind', 'contract', 'address', 'codehash'],
      ['kind', 'contract', 'address', 'codehash'],
    ]);
  });
});

describe('the escrow grants', () => {
  // Every module already present and every token already seeded, so the route
  // sends wiring only; nothing is granted yet.
  function wiringOnly() {
    const sent: string[] = [];
    const wallet = {
      account: { address: TREASURY },
      writeContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: unknown[] }) => {
        sent.push(`${address}.${functionName}(${functionName === 'grantRole' ? `${args[0]},${args[1]}` : ''})`);
        return `0x${'1'.repeat(64)}` as Hex;
      },
    };
    const chain = {
      ...treasurySender(wallet),
      publicClient: {
        waitForTransactionReceipt: async () => ({ status: 'success' }),
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === 'totalSupply') return 1n;
          if (functionName === 'resolve') return '0x0000000000000000000000000000000000000000';
          if (functionName === 'pair') return [0n, 0n, false];
          if (functionName === 'hasRole') return false;
          if (functionName.endsWith('_ROLE')) return keccak256(toBytes(functionName));
          throw new Error(`unexpected read ${functionName}`);
        },
      },
    } as unknown as Chain;
    return { chain, sent };
  }

  it('go BURNER then MINTER on every token, in manifest order, after the converter wiring', async () => {
    const planned = deriveModules(MANIFEST, TREASURY);
    const { chain, sent } = wiringOnly();
    const status: ModuleStatus[] = planned.map(() => 'present');
    await sendDeployment(chain, MANIFEST, planned, status, TREASURY, true);

    const at = (kind: string, key?: string) => planned.find((p) => p.spec.kind === kind && (key === undefined || p.spec.key === key))!.address;
    const grant = (token: Address, role: string, to: Address) => `${token}.grantRole(${keccak256(toBytes(role))},${to})`;
    const escrow = at('escrow');
    expect(sent.slice(-4)).toEqual([
      grant(at('token', 'play'), 'BURNER_ROLE', escrow),
      grant(at('token', 'play'), 'MINTER_ROLE', escrow),
      grant(at('token', 'gold'), 'BURNER_ROLE', escrow),
      grant(at('token', 'gold'), 'MINTER_ROLE', escrow),
    ]);
    expect(sent.filter((s) => s.includes(at('judgehook')))).toEqual([]);
  });
});
