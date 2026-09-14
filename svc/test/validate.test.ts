import { describe, it, expect } from 'bun:test';
import {
  assertCanonicalAgentId,
  assertAlias,
  assertLookupName,
  parseVee,
  formatVee,
  keyFileName,
} from '../src/validate.ts';
import { HttpError } from '../src/errors.ts';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : `not-an-HttpError:${String(err)}`;
  }
  return 'no-error';
}

describe('canonical agent ids', () => {
  it('accepts a qualified lowercase id', () => {
    expect(assertCanonicalAgentId('orch:shadowbroker')).toBe('orch:shadowbroker');
    expect(assertCanonicalAgentId('alpha:client')).toBe('alpha:client');
  });

  // Criterion 9: a bare local id is not an identity the ledger can key on,
  // because local ids collide across meshes.
  it('rejects a bare local id', () => {
    expect(codeOf(() => assertCanonicalAgentId('client'))).toBe('invalid_agent_id');
  });

  // Criterion 9: `orch:pod1:alice` is a relayed-topic DISPLAY artefact. If it
  // ever reaches POST /wallets it is a 400, never a registry key.
  it('rejects a two-colon relay string', () => {
    expect(codeOf(() => assertCanonicalAgentId('orch:pod1:alice'))).toBe('invalid_agent_id');
  });

  // Uppercase is refused rather than normalised: lowercasing it would key money
  // under an id the caller did not ask for, and the mesh does NOT enforce case
  // on local ids, so this is the only check standing.
  it('rejects uppercase instead of normalising it', () => {
    expect(codeOf(() => assertCanonicalAgentId('Orch:shadowbroker'))).toBe('invalid_agent_id');
    expect(codeOf(() => assertCanonicalAgentId('orch:ShadowBroker'))).toBe('invalid_agent_id');
  });

  // Without a TOTAL length bound, a 60-character id passes the shape check and
  // then reverts NameTooLong on chain - a 400 arriving at the caller as a 502.
  it('rejects an id that is within the per-part limits but over the on-chain cap', () => {
    const id = `${'a'.repeat(30)}:${'b'.repeat(30)}`;
    expect(id.length).toBe(61);
    expect(codeOf(() => assertCanonicalAgentId(id))).toBe('invalid_agent_id');
  });

  it('accepts an id exactly at the 48-character cap', () => {
    const id = `${'a'.repeat(23)}:${'b'.repeat(24)}`;
    expect(id.length).toBe(48);
    expect(assertCanonicalAgentId(id)).toBe(id);
  });

  it('rejects path traversal and separators', () => {
    expect(codeOf(() => assertCanonicalAgentId('../../etc:passwd'))).toBe('invalid_agent_id');
    expect(codeOf(() => assertCanonicalAgentId('orch:../escape'))).toBe('invalid_agent_id');
  });

  it('rejects a non-string', () => {
    expect(codeOf(() => assertCanonicalAgentId(undefined))).toBe('invalid_agent_id');
    expect(codeOf(() => assertCanonicalAgentId(42))).toBe('invalid_agent_id');
  });
});

describe('vanity aliases', () => {
  it('preserves case, because lookalikes are the game mechanic', () => {
    expect(assertAlias('aIpha.vee')).toBe('aIpha.vee');
    expect(assertAlias('alpha.vee')).toBe('alpha.vee');
    expect(assertAlias('aIpha.vee')).not.toBe(assertAlias('alpha.vee'));
  });

  // An alias with a colon could impersonate a namespaced canonical id.
  it('rejects a colon', () => {
    expect(codeOf(() => assertAlias('orch:shadowbroker'))).toBe('invalid_name');
  });

  it('enforces the 3-48 length bounds', () => {
    expect(codeOf(() => assertAlias('ab'))).toBe('invalid_name');
    expect(codeOf(() => assertAlias('a'.repeat(49)))).toBe('invalid_name');
    expect(assertAlias('a'.repeat(48))).toHaveLength(48);
  });
});

describe('lookup names', () => {
  it('accepts a canonical id or an alias', () => {
    expect(assertLookupName('orch:shadowbroker')).toBe('orch:shadowbroker');
    expect(assertLookupName('alpha.vee')).toBe('alpha.vee');
  });

  // A bare local id is SYNTACTICALLY a valid alias, so it is the registry
  // lookup that reports it unknown - not this validator. Criterion 9 expects
  // `unknown_name`, and that only happens if this lets it through.
  it('lets a bare local id through so the registry can report it unknown', () => {
    expect(assertLookupName('client')).toBe('client');
  });

  it('rejects a two-colon origin string', () => {
    expect(codeOf(() => assertLookupName('orch:pod1:alice'))).toBe('invalid_name');
  });
});

describe('amounts', () => {
  it('accepts numbers and decimal strings alike', () => {
    expect(parseVee(250)).toBe(250n * 10n ** 18n);
    expect(parseVee('250')).toBe(250n * 10n ** 18n);
    expect(parseVee('0.5')).toBe(5n * 10n ** 17n);
    expect(parseVee(0)).toBe(0n);
  });

  it('round-trips through the output format', () => {
    expect(formatVee(parseVee('1000000'))).toBe('1000000');
    expect(formatVee(parseVee('0.000000000000000001'))).toBe('0.000000000000000001');
  });

  it('rejects more than 18 decimal places', () => {
    expect(codeOf(() => parseVee('0.0000000000000000001'))).toBe('invalid_amount');
  });

  it('rejects negatives, junk and non-finite numbers', () => {
    expect(codeOf(() => parseVee('-1'))).toBe('invalid_amount');
    expect(codeOf(() => parseVee('abc'))).toBe('invalid_amount');
    expect(codeOf(() => parseVee(Number.NaN))).toBe('invalid_amount');
    expect(codeOf(() => parseVee(Number.POSITIVE_INFINITY))).toBe('invalid_amount');
    expect(codeOf(() => parseVee(null))).toBe('invalid_amount');
  });

  // A JS number big enough to render as 1e+21 cannot be handed to parseUnits.
  // Refusing beats silently rounding the game's money.
  it('rejects a number that renders in exponent form', () => {
    expect(codeOf(() => parseVee(1e21))).toBe('invalid_amount');
  });
});

describe('key file names', () => {
  it('encodes the colon so it never reaches a path', () => {
    expect(keyFileName('orch:shadowbroker')).toBe('orch%3Ashadowbroker.json');
  });

  it('leaves no separator or traversal sequence in the result', () => {
    const name = keyFileName('alpha:client');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });
});
