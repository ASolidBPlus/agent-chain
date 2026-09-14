// The allow/deny pattern dialect, and the agreement between chain-svc's copy
// and wallet-mcp's. Two implementations of one dialect is the arrangement; a
// test that they agree is what makes it safe.

import { describe, it, expect } from 'bun:test';
import { matchesPattern, assertPatternsUsable, enforcePolicy, mergePolicy, capToWei, type AgentPolicy } from '../src/policy.ts';
import { matchesPattern as mcpMatchesPattern } from '../../wallet-mcp/src/policy.ts';
import { HttpError } from '../src/errors.ts';

const POLICY: AgentPolicy = { caps: { play: { max_per_tx: 1000, max_per_stage: 5000 } }, allow: ['*'], deny: [] };

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
    ['*.play', 'runner1.play', true],
    ['*.play', 'orch:runner1', false],
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
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'acme:runner1', amount: 1n, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe(
      'counterparty_denied',
    );
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'orch:mark', amount: 1n, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe('no-error');
  });

  it('a trailing-star allow entry actually allows', () => {
    const p = { ...POLICY, allow: ['acme:*'], deny: [] };
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'acme:runner1', amount: 1n, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe('no-error');
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'orch:mark', amount: 1n, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe(
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
    expect(() => assertPatternsUsable(['*', '*.play', 'acme:*', 'orch:mark'], 'allow')).not.toThrow();
  });
});

// The four shapes MEASURED against a live stack, and the
// asymmetry that made this a ship-blocker: sending NO policy succeeded and fell
// to defaults, while sending a strictly MORE SPECIFIC one - allow/deny with the
// caps left to the defaults, the harness's whole use - was refused outright.
describe('a caller-supplied policy is a patch over the kind defaults', () => {
  const DEF: AgentPolicy = { caps: { play: { max_per_tx: 100, max_per_stage: 500 } }, allow: ['*.play'], deny: ['treasury.play'] };

  it('accepts the shape the harness sends: allow and deny, no caps', () => {
    const p = mergePolicy({ allow: ['acme:*'], deny: ['treasury.play'] }, DEF);
    expect(p.allow).toEqual(['acme:*']);
    // Fell to the kind defaults, per TOKEN now: a harness policy that names
    // only allow/deny is saying nothing about caps, so the kind's whole caps
    // map survives rather than one pair of numbers.
    expect(p.caps.play).toEqual({ max_per_tx: 100, max_per_stage: 500 });
  });

  it('accepts a complete numeric policy, as before', () => {
    const p = mergePolicy({ caps: { play: { max_per_tx: 25, max_per_stage: 100 } }, allow: ['*'], deny: [] }, DEF);
    expect(p.caps.play).toEqual({ max_per_tx: 25, max_per_stage: 100 });
  });

  // A cap IS an amount, and every other amount on these wires is a decimal
  // string. The harness's schema types caps with the same VeeString as the rest.
  it('accepts STRING caps, which the amount convention requires', () => {
    // The LEGACY pair, still accepted from a caller and read against the
    // default token - a caller writing the old shape is saying something about
    // the default token, not about every token.
    const p = mergePolicy({ max_per_tx: '25', max_per_stage: '100', allow: ['*'], deny: [] }, DEF, 'play');
    expect(capToWei(p.caps.play!.max_per_tx, 18)).toBe(25n * 10n ** 18n);
  });

  it('accepts no policy at all', () => {
    expect(mergePolicy(undefined, DEF)).toEqual(DEF);
    expect(mergePolicy(null, DEF)).toEqual(DEF);
  });

  it('a number and its string spelling compare identically', () => {
    expect(capToWei(25, 18)).toBe(capToWei('25', 18));
    expect(capToWei('12.5', 18)).toBe(12_500_000_000_000_000_000n);
  });

  // The cap check must not go through a float, which is the whole reason the
  // string form exists: this value is exact in wei and not as a double.
  it('enforces a fractional cap exactly', () => {
    const p = mergePolicy({ max_per_tx: '0.3' }, DEF, 'play');
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'a.play', amount: capToWei('0.3', 18), decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe('no-error');
    expect(codeOf(() => enforcePolicy({ policy: p, to: 'a.play', amount: capToWei('0.3', 18) + 1n, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe(
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
  const P: AgentPolicy = { caps: { play: { max_per_tx: 100, max_per_stage: 500 } }, allow: ['*'], deny: [] };

  it('refuses zero', () => {
    expect(codeOf(() => enforcePolicy({ policy: P, to: 'a.play', amount: 0n, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe('invalid_amount');
  });

  it('still admits the smallest real amount', () => {
    expect(codeOf(() => enforcePolicy({ policy: P, to: 'a.play', amount: 1n, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe('no-error');
  });

  // Refused BEFORE the cap check, so the reason a caller sees is the true one
  // rather than whichever check happens to run first.
  it('reports the amount, not the cap, for a zero over an exhausted policy', () => {
    const tiny: AgentPolicy = { ...P, caps: { play: { max_per_tx: 1, max_per_stage: 1 } } };
    expect(codeOf(() => enforcePolicy({ policy: tiny, to: 'a.play', amount: 0n, decimals: 18, symbol: 'PLAY', tokenKey: 'play' }))).toBe('invalid_amount');
  });
});
