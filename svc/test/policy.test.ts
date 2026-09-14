// The allow/deny pattern dialect, and the agreement between chain-svc's copy
// and wallet-mcp's. Two implementations of one dialect is the arrangement; a
// test that they agree is what makes it safe.

import { describe, it, expect } from 'bun:test';
import { matchesPattern, assertPatternsUsable, enforcePolicy, mergePolicy, capToWei, type AgentPolicy } from '../src/policy.ts';
import { matchesPattern as mcpMatchesPattern } from '../../wallet-mcp/src/policy.ts';
import { HttpError } from '../src/errors.ts';

const POLICY: AgentPolicy = { max_per_tx: 1000, max_per_stage: 5000, allow: ['*'], deny: [] };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : `not-an-HttpError: ${String(err)}`;
  }
  return 'no-error';
}


// The trailing-star form, and the agreement between the two copies. `acme:*`
// matched NOTHING before this: it fell through to the literal comparison and
// was compared as the seven-character string. In an allow list that refuses
// everything, which is loud; in a DENY list it denies nothing, which is not.
describe('the pattern dialect', () => {
  const CASES: Array<[string, string, boolean]> = [
    ['*', 'anything', true],
    ['*.vee', 'runner1.vee', true],
    ['*.vee', 'orch:runner1', false],
    ['acme:*', 'acme:runner1', true],
    ['acme:*', 'acme:', true],
    ['acme:*', 'orch:runner1', false],
    ['acme:*', 'xacme:runner1', false],
    ['orch:mark', 'orch:mark', true],
    ['orch:mark', 'orch:marker', false],
  ];

  it.each(CASES)('chain-svc: %s vs %s', (pattern, name, expected) => {
    expect(matchesPattern(pattern, name)).toBe(expected);
  });

  // THE PROPERTY THAT MATTERS: the two copies cannot drift. wallet-mcp's
  // refusal is the model-facing fast path and chain-svc's is the boundary; a
  // pattern meaning different things in the two is the drift the shared policy
  // file exists to prevent.
  it.each(CASES)('wallet-mcp agrees: %s vs %s', (pattern, name, expected) => {
    expect(mcpMatchesPattern(pattern, name)).toBe(expected);
  });

  // Asserted through the LISTS, not just the matcher, because deny and allow
  // consume it differently and the deny direction is the one that fails quietly.
  it('a trailing-star deny entry actually denies', () => {
    const p = { ...POLICY, allow: ['*'], deny: ['acme:*'] };
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'acme:runner1', amount: 1n }))).toBe(
      'counterparty_denied',
    );
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'orch:mark', amount: 1n }))).toBe('no-error');
  });

  it('a trailing-star allow entry actually allows', () => {
    const p = { ...POLICY, allow: ['acme:*'], deny: [] };
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'acme:runner1', amount: 1n }))).toBe('no-error');
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'orch:mark', amount: 1n }))).toBe(
      'counterparty_denied',
    );
  });

  // A star this dialect does not implement is refused AT LOAD, with a name,
  // rather than silently becoming a literal that matches nothing.
  it('refuses a star in an unsupported position, in both lists', () => {
    for (const bad of ['a*b', '**', 'a*b*c', '*mid*']) {
      expect(() => assertPatternsUsable([bad], 'deny')).toThrow(/not supported/);
      expect(() => assertPatternsUsable([bad], 'allow')).toThrow(/not supported/);
    }
  });

  it('accepts every form the dialect does implement', () => {
    expect(() => assertPatternsUsable(['*', '*.vee', 'acme:*', 'orch:mark'], 'allow')).not.toThrow();
  });
});

// The four shapes MEASURED against a live stack, and the
// asymmetry that made this a ship-blocker: sending NO policy succeeded and fell
// to defaults, while sending a strictly MORE SPECIFIC one - allow/deny with the
// caps left to the defaults, the harness's whole use - was refused outright.
describe('a caller-supplied policy is a patch over the kind defaults', () => {
  const DEF: AgentPolicy = { max_per_tx: 100, max_per_stage: 500, allow: ['*.vee'], deny: ['treasury.vee'] };

  it('accepts the shape the harness sends: allow and deny, no caps', () => {
    const p = mergePolicy({ allow: ['acme:*'], deny: ['treasury.vee'] }, DEF);
    expect(p.allow).toEqual(['acme:*']);
    expect(p.max_per_tx).toBe(100); // fell to the default
    expect(p.max_per_stage).toBe(500);
  });

  it('accepts a complete numeric policy, as before', () => {
    const p = mergePolicy({ max_per_tx: 25, max_per_stage: 100, allow: ['*'], deny: [] }, DEF);
    expect(p.max_per_tx).toBe(25);
  });

  // A cap IS an amount, and every other amount on these wires is a decimal
  // string. The harness's schema types caps with the same VeeString as the rest.
  it('accepts STRING caps, which the amount convention requires', () => {
    const p = mergePolicy({ max_per_tx: '25', max_per_stage: '100', allow: ['*'], deny: [] }, DEF);
    expect(capToWei(p.max_per_tx)).toBe(25n * 10n ** 18n);
  });

  it('accepts no policy at all', () => {
    expect(mergePolicy(undefined, DEF)).toEqual(DEF);
    expect(mergePolicy(null, DEF)).toEqual(DEF);
  });

  it('a number and its string spelling compare identically', () => {
    expect(capToWei(25)).toBe(capToWei('25'));
    expect(capToWei('12.5')).toBe(12_500_000_000_000_000_000n);
  });

  // The cap check must not go through a float, which is the whole reason the
  // string form exists: this value is exact in wei and not as a double.
  it('enforces a fractional cap exactly', () => {
    const p = mergePolicy({ max_per_tx: '0.3' }, DEF);
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'a.vee', amount: capToWei('0.3') }))).toBe('no-error');
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'a.vee', amount: capToWei('0.3') + 1n }))).toBe(
      'over_max_per_tx',
    );
  });

  it('still refuses a cap that is not an amount', () => {
    for (const bad of [0, -5, 1.5, '', 'lots', '-5', '1e3', null, {}]) {
      expect(() => mergePolicy({ max_per_tx: bad }, DEF)).toThrow(/max_per_tx/);
    }
  });

  it('still refuses a malformed pattern, in either list', () => {
    expect(() => mergePolicy({ allow: ['a*b'] }, DEF)).toThrow(/not supported/);
    expect(() => mergePolicy({ deny: ['a*b'] }, DEF)).toThrow(/not supported/);
  });

  it('refuses a policy that is not an object', () => {
    expect(() => mergePolicy('nope', DEF)).toThrow(/must be an object/);
  });
});
// The boundary must not depend on wallet-mcp's check. `parseVee` accepts "0"
// deliberately - it is a parser - and wallet-mcp refuses `vee <= 0` for the
// model. A direct caller with a wallet token bypasses wallet-mcp entirely.
describe('a zero-VEE transfer is refused at the boundary', () => {
  const P: AgentPolicy = { max_per_tx: 100, max_per_stage: 500, allow: ['*'], deny: [] };

  it('refuses zero', () => {
    expect(codeOf(() => enforcePolicy({ policy: P, to: 'a.vee', amount: 0n }))).toBe('invalid_amount');
  });

  it('still admits the smallest real amount', () => {
    expect(codeOf(() => enforcePolicy({ policy: P, to: 'a.vee', amount: 1n }))).toBe('no-error');
  });

  // Refused BEFORE the cap check, so the reason a caller sees is the true one
  // rather than whichever check happens to run first.
  it('reports the amount, not the cap, for a zero over an exhausted policy', () => {
    const tiny: AgentPolicy = { ...P, max_per_tx: 1 };
    expect(codeOf(() => enforcePolicy({ policy: tiny, to: 'a.vee', amount: 0n }))).toBe('invalid_amount');
  });
});
