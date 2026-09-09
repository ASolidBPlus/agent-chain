import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLocally, normaliseVee, veeToWei, matchesPattern, readPolicy, type WalletPolicy } from '../src/policy.ts';

const POLICY: WalletPolicy = {
  agentId: 'orch:shadowbroker',
  max_per_tx: 100,
  max_per_stage: 500,
  allow: ['*.vee'],
  deny: ['treasury.vee'],
  frozen: false,
};

describe('pattern matching', () => {
  it('uses the same restricted dialect as chain-svc', () => {
    expect(matchesPattern('*', 'anything')).toBe(true);
    expect(matchesPattern('*.vee', 'alpha.vee')).toBe(true);
    expect(matchesPattern('*.vee', 'alpha.veex')).toBe(false);
    expect(matchesPattern('treasury.vee', 'treasury.vee')).toBe(true);
  });
});

describe('the local pre-check', () => {
  it('refuses over max_per_tx, a denied counterparty, and a frozen wallet', () => {
    expect(checkLocally(POLICY, 'alpha.vee', '150')).toBe('over_max_per_tx');
    expect(checkLocally(POLICY, 'treasury.vee', '1')).toBe('counterparty_denied');
    expect(checkLocally({ ...POLICY, frozen: true }, 'alpha.vee', '1')).toBe('frozen');
  });

  it('refuses a counterparty no allow rule covers', () => {
    expect(checkLocally({ ...POLICY, allow: [] }, 'alpha.vee', '1')).toBe('counterparty_denied');
    expect(checkLocally(POLICY, 'alpha.wat', '1')).toBe('counterparty_denied');
  });

  it('passes a send nothing local objects to', () => {
    expect(checkLocally(POLICY, 'alpha.vee', '100')).toBeNull();
  });

  // Deliberate: the stage cap counts spends since the last stage change, and
  // this process has no stage source - hub-core's /session needs a platform
  // credential, which by design never reaches the agent side. So the refusal
  // comes from chain-svc, which is the authority anyway.
  it('does not attempt the stage cap locally', () => {
    expect(checkLocally(POLICY, 'alpha.vee', '100')).toBeNull();
  });

  // An unreadable policy is NOT permission and NOT a refusal: chain-svc decides.
  // Returning 'frozen' here would strand an agent on a transient read error;
  // approving would be worse.
  it('defers to chain-svc when the policy cannot be read', () => {
    expect(checkLocally(null, 'alpha.vee', '999999')).toBeNull();
  });
});

describe('reading the policy file', () => {
  it('reads a written policy and reports an unusable one as null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(POLICY));
    expect(readPolicy(good)?.max_per_tx).toBe(100);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(readPolicy(bad)).toBeNull();
    expect(readPolicy(join(dir, 'missing.json'))).toBeNull();
  });

  // chain-svc rewrites this file to frozen:true when a wallet is retired, so a
  // cached copy would keep spending for the life of the process.
  it('sees a freeze written after the process started', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const path = join(dir, 'p.json');
    writeFileSync(path, JSON.stringify(POLICY));
    expect(readPolicy(path)?.frozen).toBe(false);

    writeFileSync(path, JSON.stringify({ ...POLICY, frozen: true }));
    expect(readPolicy(path)?.frozen).toBe(true);
  });
});

// Ruled 03:55: `vee` is a decimal string on every money wire. A whole NUMBER is
// tolerated because a model writes 50 as readily as "50" and an integer is
// exactly representable; a fractional number is REFUSED, never rounded.
describe('normaliseVee', () => {
  it('accepts a decimal string and passes it through untouched', () => {
    expect(normaliseVee('50')).toBe('50');
    // Not re-parsed: "12.50" must not become "12.5", because the string IS the
    // value and round-tripping through a float is what this type prevents.
    expect(normaliseVee('12.50')).toBe('12.50');
    expect(normaliseVee('0.000000000000000001')).toBe('0.000000000000000001');
  });

  it('accepts a whole number, which rounds nothing', () => {
    expect(normaliseVee(50)).toBe('50');
    expect(normaliseVee(1)).toBe('1');
  });

  it('REFUSES a fractional number rather than rounding it', () => {
    // The case that motivated the ruling: 0.1 + 0.2 is where money goes wrong
    // quietly, so this is a refusal and not a best effort.
    expect(normaliseVee(12.5)).toBeNull();
    expect(normaliseVee(0.1 + 0.2)).toBeNull();
  });

  it('refuses everything that is not a positive amount', () => {
    for (const bad of ['', '-5', '5.', '.5', '1e3', '1,000', 'fifty', '0', 0, -1, NaN, Infinity, null, undefined, {}]) {
      expect(normaliseVee(bad)).toBeNull();
    }
  });

  it('compares against max_per_tx in wei, not as a float', () => {
    expect(veeToWei('12.5')).toBe(12_500_000_000_000_000_000n);
    expect(veeToWei('1')).toBe(10n ** 18n);
    // The comparison the cap actually makes, at a value a float would fumble.
    expect(checkLocally({ ...POLICY, max_per_tx: 100 }, 'alpha.vee', '100')).toBeNull();
    expect(checkLocally({ ...POLICY, max_per_tx: 100 }, 'alpha.vee', '100.000000000000000001')).toBe(
      'over_max_per_tx',
    );
  });
});
