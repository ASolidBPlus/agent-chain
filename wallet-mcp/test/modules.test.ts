// The token resolver: the one place a manifest KEY and a token SYMBOL meet on
// this side of the wire.

import { describe, it, expect } from 'bun:test';
import { defaultTokenOf, resolveTokenOrRefusal, type ModulesReply } from '../src/modules.ts';
import { RESOLVER_CASES, RESOLVER_DEFAULT, RESOLVER_TOKENS } from './resolver-cases.ts';

const MODULES: ModulesReply = {
  schema: 1,
  chainId: 31337,
  treasury: '0xtreasury',
  defaultToken: RESOLVER_DEFAULT,
  tokens: RESOLVER_TOKENS,
  names: { address: '0xreg', tld: 'play' },
};

/// A deployment with names and no token module - which is a supported shape,
/// not a broken one.
const TOKENLESS: ModulesReply = {
  ...MODULES,
  defaultToken: null,
  tokens: [],
};

describe('resolveTokenOrRefusal', () => {
  // The SHARED table, run here against this package's resolver. chain-svc runs
  // the same rows against its own in svc/test - that is the agreement, and this
  // half of it is worth having on its own: it is what pins the rules the other
  // half is being compared to.
  for (const row of RESOLVER_CASES) {
    it(`resolves ${row.what}`, () => {
      const got = resolveTokenOrRefusal(MODULES, row.input);
      if ('token' in row.expect) {
        expect(got.ok).toBe(true);
        expect(got.ok && got.token.key).toBe(row.expect.token);
        return;
      }
      expect(got.ok).toBe(false);
      // `unknown` is persona-facing and names the registry; `invalid` is a fact
      // about the argument's TYPE, which this package does not have a refusal
      // string for and reports generically.
      expect(!got.ok && got.reason).toBe(row.expect.refuse === 'unknown' ? 'unknown_token' : 'error');
    });
  }

  // The refusal earns its keep by letting a model fix its own call, so it lists
  // what exists - in BOTH namespaces, because either is accepted back.
  it('names every token it has when it refuses one it has not', () => {
    const got = resolveTokenOrRefusal(MODULES, 'nope');
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.detail).toContain('"nope"');
    for (const t of RESOLVER_TOKENS) {
      expect(got.detail).toContain(t.key);
      expect(got.detail).toContain(t.symbol);
    }
  });

  // The SHAPE of the deployment, not its registry - and they are different
  // answers. Telling a persona on a names-only deployment "no token GOLD" would
  // have it hunt for the right spelling of a currency that does not exist here.
  it('separates a tokenless deployment from an unknown token', () => {
    const named = resolveTokenOrRefusal(TOKENLESS, 'play');
    expect(named).toEqual({ ok: false, reason: 'error', detail: 'this deployment has no token module' });
    // And the tokenless case answers FIRST: with no tokens, even an absent
    // argument cannot fall through to a default that is not there.
    expect(resolveTokenOrRefusal(TOKENLESS, undefined)).toEqual({
      ok: false,
      reason: 'error',
      detail: 'this deployment has no token module',
    });
  });

  // A manifest can name a default that no token module provides. That is a
  // deployment fault rather than a caller fault, so it is not `unknown_token`.
  it('refuses when the named default is not among the tokens', () => {
    const broken: ModulesReply = { ...MODULES, defaultToken: 'missing' };
    expect(resolveTokenOrRefusal(broken, undefined)).toEqual({
      ok: false,
      reason: 'error',
      detail: 'this deployment has no default token',
    });
    // The tokens it DOES have are still resolvable; only the default is broken.
    expect(resolveTokenOrRefusal(broken, 'au').ok).toBe(true);
  });
});

describe('defaultTokenOf', () => {
  it('is the token the manifest named, not the first one listed', () => {
    const second: ModulesReply = { ...MODULES, defaultToken: 'au' };
    expect(defaultTokenOf(second)?.symbol).toBe('GOLD');
    expect(defaultTokenOf(MODULES)?.symbol).toBe('PLAY');
  });

  it('is null on a deployment with no token module', () => {
    expect(defaultTokenOf(TOKENLESS)).toBeNull();
  });
});
