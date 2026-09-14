// The store and the chain state share one lifetime (spec S4), and the pair can
// come apart in two directions. #52 detects the store wiped beside a live
// chain. This is the other direction: the chain replaced while the store
// survives, which leaves every spawn marker pointing at names that no longer
// exist and has no repair path.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { blankComments } from './support/source.ts';
import { assertDeploymentUnchanged, ChainSwapError, type DeploymentIdentity } from '../src/deployment.ts';

const A: DeploymentIdentity = { chainId: '31337', modules: [{ kind: 'token' as const, key: 'vee', address: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }, { kind: 'names' as const, address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' }] };
const B: DeploymentIdentity = {
  ...A,
  modules: [{ ...A.modules[0]!, address: '0x0000000000000000000000000000000000000BBB' }, A.modules[1]!],
};

const codeOf = (fn: () => void) => {
  try {
    fn();
    return 'no-throw';
  } catch (err) {
    return (err as { code?: string }).code ?? 'not-coded';
  }
};

describe('the chain this store belongs to', () => {
  it('starts clean on a store that has never seen a deployment', () => {
    expect(codeOf(() => assertDeploymentUnchanged(null, A, false))).toBe('no-throw');
  });

  it('starts clean when the deployment is the one it was written against', () => {
    expect(codeOf(() => assertDeploymentUnchanged(A, A, false))).toBe('no-throw');
  });

  // The whole finding. Same store, different chain.
  it('REFUSES when the chain has been replaced under the store', () => {
    expect(codeOf(() => assertDeploymentUnchanged(A, B, false))).toBe('chain_replaced_under_store');
  });

  // A redeploy onto a fresh chain moves the contract addresses even when the
  // chain id is identical - which is exactly the case that cost three rebuilds,
  // and which a chain-id-only check would miss.
  it('notices a redeploy that keeps the same chain id', () => {
    expect(A.chainId).toBe(B.chainId);
    expect(codeOf(() => assertDeploymentUnchanged(A, B, false))).toBe('chain_replaced_under_store');
  });

  it('notices a different chain id with the same addresses', () => {
    const other = { ...A, chainId: '1337' };
    expect(codeOf(() => assertDeploymentUnchanged(A, other, false))).toBe('chain_replaced_under_store');
  });

  // Addresses are compared case-insensitively: EIP-55 checksumming is a display
  // choice, and a store written before a client started checksumming would
  // otherwise report a swap that never happened.
  it('does not report a swap on a checksum difference alone', () => {
    const lower = { ...A, modules: A.modules.map((m) => ({ ...m, address: m.address.toLowerCase() })) };
    expect(codeOf(() => assertDeploymentUnchanged(A, lower, false))).toBe('no-throw');
  });

  it('names BOTH deployments and the way out', () => {
    let message = '';
    try { assertDeploymentUnchanged(A, B, false); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(A.modules[0]!.address);
    expect(message).toContain(B.modules[0]!.address);
    expect(message).toContain('--acknowledge-chain-reset');
    // The symptom points at the one component that is fine, so the message has
    // to say which thing is actually wrong.
    expect(message).toContain('unknown_name');
    expect(message).toContain('only the PAIRING is wrong');
  });

  describe('the acknowledgement', () => {
    it('permits the boot', () => {
      expect(codeOf(() => assertDeploymentUnchanged(A, B, true))).toBe('no-throw');
    });

    // IT PERMITS AND DOES NOT RESOLVE. Quieting it would be a detector
    // reporting "fixed" when nothing is fixed: the wallets are still
    // unregistered and the operator still meets unknown_name at runtime.
    // Updating the record is repair's job, at the point where "these now agree"
    // becomes true.
    it('does not make the disagreement go away for the next boot', () => {
      expect(codeOf(() => assertDeploymentUnchanged(A, B, true))).toBe('no-throw');
      // Same inputs, no acknowledgement: still refused.
      expect(codeOf(() => assertDeploymentUnchanged(A, B, false))).toBe('chain_replaced_under_store');
    });
  });
});

describe('the store records which chain it belongs to', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deploy-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads back null before anything is recorded', () => {
    const s = new Store(join(dir, 'a.sqlite'));
    expect(s.recordedDeployment()).toBeNull();
    s.close();
  });

  it('records and reads back the identity', () => {
    const path = join(dir, 'b.sqlite');
    const s = new Store(path);
    s.recordDeployment(A);
    s.close();
    const again = new Store(path);
    expect(again.recordedDeployment()).toEqual(A);
    again.close();
  });

  // WRITTEN ONCE. A second record must not overwrite the first, or an
  // acknowledged boot that happens to call it would silently resolve the
  // disagreement it was told to tolerate.
  it('never overwrites what it already recorded', () => {
    const s = new Store(join(dir, 'c.sqlite'));
    s.recordDeployment(A);
    s.recordDeployment(B);
    expect(s.recordedDeployment()).toEqual(A);
    s.close();
  });
});

// THE CALL SITE, structurally - the same idiom as the ledger-lifetime guard,
// and for the same reason: the decision and the facts are pinned above, and the
// WIRE that connects them lives in index.ts where no test reaches. A constant
// there would leave this control dormant with every test green.
describe('the call site in index.ts', () => {
  const indexSrc = () => Bun.file(new URL('../src/index.ts', import.meta.url)).text();

  it('wires the check to the real store and the real deployment', async () => {
    // Comments blanked with the shared helper, so a comment naming the call
    // cannot be mistaken for the call. This started as a count of the call
    // form - an honest weaker instrument, used because the helper was on an
    // unmerged branch - and the weaker one is gone rather than left in the tree
    // with a promise to collapse it later.
    const src = blankComments(await indexSrc());
    const call = src.indexOf('assertDeploymentUnchanged(');
    expect(call).toBeGreaterThan(-1);
    const wiring = src.slice(src.indexOf('const liveDeployment ='), call + 160);

    // Each fact from its own source, not a literal. The identity is now a
    // module LIST, so the wiring to check is that the list is built from the
    // loaded deployment's own modules rather than from anything reconstructed.
    expect(wiring).toContain('deployment.chainId');
    expect(wiring).toContain('deployment.modules.map(');
    expect(wiring).toContain('kind: m.kind');
    expect(wiring).toContain('address: m.address');
    expect(wiring).toContain('store.recordedDeployment()');
    expect(wiring).toContain('config.acknowledgeChainReset');
  });

  // ORDER MATTERS. A store pointed at a chain it was not written against cannot
  // resolve any name it recorded, so a later check would be reasoning about a
  // pairing that is already known to be wrong - and nothing may serve first.
  it('runs BEFORE the ledger check and before the server listens', async () => {
    const src = blankComments(await indexSrc());
    const swap = src.indexOf('assertDeploymentUnchanged(');
    const ledger = src.indexOf('assertLedgerLifetimeIntact(');
    const listen = src.indexOf('server.listen');
    expect(swap).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(swap).toBeLessThan(ledger);
    expect(swap).toBeLessThan(listen);
  });

  // RECORDED ONLY WHEN THERE IS NOTHING RECORDED. If the entrypoint recorded
  // unconditionally, an acknowledged boot would overwrite the old identity and
  // the next boot would see agreement - the detector reporting "fixed" when
  // nothing was fixed. The store refuses the overwrite too; this pins that the
  // entrypoint does not ask for it.
  it('records only on a store that has never seen a deployment', async () => {
    const src = blankComments(await indexSrc());
    const at = src.indexOf('store.recordDeployment(');
    expect(at).toBeGreaterThan(-1);
    const line = src.slice(src.lastIndexOf('\n', at) + 1, at);
    expect(line).toContain('recordedDeployment === null');
  });
});
