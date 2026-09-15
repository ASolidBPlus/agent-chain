// The allow/deny pattern dialect, and the agreement between chain-svc's copy
// and wallet-mcp's. Two implementations of one dialect is the arrangement; a
// test that they agree is what makes it safe.

import { describe, it, expect } from 'bun:test';
import { matchesPattern, assertPatternsUsable, capsFor, enforcePolicy, mergePolicy, capToWei, UNLIMITED, type AgentPolicy } from '../src/policy.ts';
import { matchesPattern as mcpMatchesPattern } from '../../wallet-mcp/src/policy.ts';
import { HttpError } from '../src/errors.ts';
import { RESOLVER_CASES, RESOLVER_DEFAULT, RESOLVER_TOKENS } from '../../wallet-mcp/test/resolver-cases.ts';
import { capsRefusal, checkLocally, UNLIMITED as UNLIMITED_MCP } from '../../wallet-mcp/src/policy.ts';
import { resolveTokenOrRefusal } from '../../wallet-mcp/src/modules.ts';
import { resolveToken, type Modules } from '../src/modules.ts';

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

// THE SECOND AND THIRD AGREEMENT TESTS, beside the pattern-dialect one at the
// top of this file and for the same reason it exists: two implementations of
// one rule is the arrangement, and a test that they agree is what makes it
// safe.
//
// Both pairs exist because wallet-mcp keeps ZERO RUNTIME DEPENDENCY on
// chain-svc - its import is `import type`, which is erased, so the package runs
// with chain-svc absent, which is what org-core needs when it imports Wallet as
// a library. Sharing a function would cost that property; sharing a TEST costs
// nothing, because a test import is not a runtime import.
describe('the token resolver, on both sides', () => {
  // ONE TABLE, IMPORTED rather than copied. A copied table drifts the first
  // time somebody adds a row to the side they happen to be editing - and a
  // table that does not agree about what it is testing cannot catch two
  // functions that do not agree either.
  const modules: Modules = {
    tokens: RESOLVER_TOKENS.map((t) => ({ ...t, address: t.address as `0x${string}` })),
    contracts: [],
    byKey: new Map(),
  };
  const reply = { schema: 1, chainId: 31337, treasury: '0x0', defaultToken: RESOLVER_DEFAULT, tokens: RESOLVER_TOKENS, names: null };

  for (const row of RESOLVER_CASES) {
    it(`agrees on ${row.what}`, () => {
      // Each side mapped to the table's OUTCOME vocabulary, because the two
      // refuse differently by design - chain-svc throws a wire code, wallet-mcp
      // returns a persona-facing reason. Writing the table in either side's
      // codes would have made the other's mapping part of the thing under test.
      const chainSvc = (() => {
        try {
          return { token: resolveToken(modules, row.input).key };
        } catch (err) {
          const code = (err as HttpError).code;
          return { refuse: code === 'invalid_request' ? 'invalid' : 'unknown' };
        }
      })();

      const mcp = (() => {
        const r = resolveTokenOrRefusal(reply as never, row.input);
        if (r.ok) return { token: r.token.key };
        return { refuse: r.reason === 'unknown_token' ? 'unknown' : 'invalid' };
      })();

      expect(chainSvc).toEqual(row.expect);
      expect(mcp).toEqual(row.expect);
    });
  }

  it('answers module_not_deployed on BOTH sides when there is no token at all', () => {
    // The one row that cannot live in the shared table, because the two codes
    // are not two spellings of one outcome: chain-svc says
    // `module_not_deployed` because that is the wire code for a deployment's
    // shape, and wallet-mcp says `error` because the shape is not a persona's
    // business. What they agree on is that it is NOT `unknown_token`.
    const empty: Modules = { tokens: [], contracts: [], byKey: new Map() };
    expect(codeOf(() => resolveToken(empty, 'play'))).toBe('module_not_deployed');

    const r = resolveTokenOrRefusal({ ...reply, tokens: [] } as never, 'play');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toBe('unknown_token');
  });
});

describe('the caps refusal, on both sides', () => {
  // THE SAME SENTENCE, not merely the same verdict. A persona meeting the fast
  // path's refusal and the boundary's must read one rule, or the two become two
  // rules the day either is reworded.
  const policy = {
    caps: { play: { max_per_tx: '100', max_per_stage: '500' } },
    allow: ['*'],
    deny: [],
    frozen: false,
  };

  it('agrees that a token with no entry cannot be spent, in the same words', () => {
    const chainSvc = (() => {
      try {
        capsFor(policy as never, 'au');
        return null;
      } catch (err) {
        return { reason: (err as HttpError).code, detail: (err as HttpError).detail };
      }
    })();

    expect(chainSvc).toEqual({ reason: 'no_cap_set', detail: 'no cap set for au' });
    expect(capsRefusal(policy as never, 'au')).toEqual({
      reason: 'no_cap_set',
      detail: 'no cap set for au',
    });
  });

  it('agrees that a token WITH an entry is spendable, so the test can fail either way', () => {
    // COMPARE TO A VALUE. Without this row both sides could refuse everything
    // and the row above would still pass - the empty-set failure, one level up.
    expect(() => capsFor(policy as never, 'play')).not.toThrow();
    expect(capsRefusal(policy as never, 'play')).toBeNull();
  });

  it('agrees that a HALF-WRITTEN entry is not an entry', () => {
    const half = { ...policy, caps: { au: { max_per_tx: '1' } } };
    expect(codeOf(() => capsFor(half as never, 'au'))).toBe('no_cap_set');
    expect(capsRefusal(half as never, 'au')).not.toBeNull();
  });

  // §1b, AT THE POINT OF USE. `capsFor` tested only `=== undefined`, so a
  // per-wallet policy carrying a typo reached `stageCapWei`/`enforcePolicy` and
  // threw a raw SyntaxError or became a 0n cap. Not reachable through a FILE,
  // because `isPolicy` gates every read - but that gate's consequence is the
  // wrong one: a typo'd file reads as NO POLICY and this service falls back to
  // the kind defaults, which are WIDER, while wallet-mcp answers `no_cap_set`.
  // The two layers would disagree about exactly the value class §1b ruled on,
  // and disagree in the permissive direction here.
  it('agrees that an UNREADABLE cap value is no cap, on both sides', () => {
    for (const bad of ['unlimted', 'UNLIMITED', '', 'none', null, 0, -5]) {
      const p = { ...policy, caps: { play: { max_per_tx: bad, max_per_stage: '500' } } };
      expect(codeOf(() => capsFor(p as never, 'play'))).toBe('no_cap_set');
      expect(capsRefusal(p as never, 'play')).toEqual({
        reason: 'no_cap_set',
        detail: 'no cap set for play',
      });
    }
  });

  // THE `"unlimited"` ROW, and the ABSENT row beside it - the two must not
  // collapse into each other in either direction, and a table with only one of
  // them cannot tell them apart.
  //
  // THIS ROW COMPARES THE SPEND DECISION, not the cap lookup. `capsRefusal` and
  // `capsFor` both answer "is there an entry", and `"unlimited"` IS an entry, so
  // a lookup-level row passes on both sides whether or not either one skips the
  // bound. Removing wallet-mcp's per-tx skip left svc 697/0 green - the
  // divergence guard did not exist until this row.
  it('agrees that an "unlimited" per-tx cap lets any amount through', () => {
    const unl = { ...policy, caps: { play: { max_per_tx: UNLIMITED, max_per_stage: '500' } } };
    const huge = 10n ** 30n;

    // chain-svc: no throw at all.
    expect(() =>
      enforcePolicy({
        policy: unl as never,
        to: 'alpha.play',
        amount: huge,
        decimals: 18,
        symbol: 'PLAY',
        tokenKey: 'play',
      }),
    ).not.toThrow();

    // wallet-mcp: nothing local objects.
    expect(checkLocally(unl as never, 'alpha.play', '1000000000000', { key: 'play', decimals: 18 })).toBeNull();

    // ...and the constant they each tested against is the same one.
    expect(UNLIMITED_MCP).toBe(UNLIMITED);
  });

  it('agrees that an ABSENT cap is still refused, however unlimited another is', () => {
    // The fail-closed direction, beside the row above so neither can be read as
    // licence for the other: `"unlimited"` is a decision someone wrote down and
    // silence is not.
    const unl = { ...policy, caps: { play: { max_per_tx: UNLIMITED, max_per_stage: UNLIMITED } } };
    expect(codeOf(() => capsFor(unl as never, 'au'))).toBe('no_cap_set');
    expect(capsRefusal(unl as never, 'au')?.reason).toBe('no_cap_set');
  });
});
