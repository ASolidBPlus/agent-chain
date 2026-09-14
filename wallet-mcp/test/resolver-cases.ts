// THE SHARED TABLE for the token resolver, and the fixture it runs against.
//
// Two implementations of one rule - `resolveToken` in svc/src/modules.ts and
// `resolveTokenOrRefusal` in wallet-mcp/src/modules.ts - and a table that they
// agree. The same arrangement `matchesPattern` already has, for the same
// reason: a local resolution that disagreed with the boundary's would send a
// persona's payment in one token and bill it in another, and each side's own
// tests would pass.
//
// ONE LIST, imported by both suites rather than copied into each. A copied
// table drifts the first time somebody adds a row to the side they happen to be
// editing, and a table that does not agree about what it is testing cannot
// catch two functions that do not agree either.
//
// The EXPECTATION is written in neither side's vocabulary. The two refuse
// differently by design - chain-svc throws an `HttpError` carrying a wire code,
// wallet-mcp returns a `Refusal` a persona reads - so the row names the
// OUTCOME and each suite maps it to its own codes. Writing the table in one
// side's codes would have made the other side's mapping part of the thing under
// test.

export interface ResolverToken {
  key: string;
  address: string;
  symbol: string;
  decimals: number;
}

/// THREE TOKENS, and the third exists to make the two namespaces DISAGREE.
///
///   play / PLAY   - the default, eighteen places
///   au   / GOLD   - a symbol that is NOT its key upper-cased, at six places
///   gold / AUX    - a KEY that collides with the previous token's SYMBOL
///
/// Without the third, "key first, then symbol" and "symbol first, then key"
/// give the same answer to every input, and the ordering rule - the key
/// namespace wins, because the key is what the ledger stores - is untested on
/// both sides at once. Without the second, a lookup in the wrong namespace
/// still finds the right token and every row passes anyway.
export const RESOLVER_TOKENS: ResolverToken[] = [
  { key: 'play', address: '0xplay', symbol: 'PLAY', decimals: 18 },
  { key: 'au', address: '0xgold', symbol: 'GOLD', decimals: 6 },
  { key: 'gold', address: '0xaux', symbol: 'AUX', decimals: 8 },
];

export const RESOLVER_DEFAULT = 'play';

/// What a row expects: the KEY of the token that must come back, or the kind of
/// refusal. `invalid` is "that is not a string"; `unknown` is "no such token".
export type ResolverExpectation = { token: string } | { refuse: 'invalid' | 'unknown' };

export interface ResolverCase {
  what: string;
  input: unknown;
  expect: ResolverExpectation;
}

export const RESOLVER_CASES: ResolverCase[] = [
  // Absent means the default, in all three spellings a caller can produce.
  { what: 'undefined is the default token', input: undefined, expect: { token: 'play' } },
  { what: 'null is the default token', input: null, expect: { token: 'play' } },
  { what: 'an empty string is the default token', input: '', expect: { token: 'play' } },

  // The key namespace, exactly and case-folded.
  { what: 'an exact key', input: 'play', expect: { token: 'play' } },
  { what: 'a key in mixed case', input: 'Play', expect: { token: 'play' } },
  { what: 'the other token by key', input: 'au', expect: { token: 'au' } },
  { what: 'a key in upper case', input: 'AU', expect: { token: 'au' } },

  // The symbol namespace. `AUX` is not `gold` upper-cased, so a lookup that
  // searched keys twice answers `unknown` here instead of finding it anyway.
  { what: 'a symbol as written', input: 'AUX', expect: { token: 'gold' } },
  { what: 'a symbol in lower case', input: 'aux', expect: { token: 'gold' } },
  { what: 'the default token by its symbol', input: 'PLAY', expect: { token: 'play' } },

  // THE ORDERING ROW, in both cases. `gold` is one token's KEY and another
  // token's SYMBOL; the key wins, because the key is what the ledger and the
  // stage-spend rows store. Resolved by symbol, these two return `au` and the
  // bookkeeping would name a different token than the transfer moved.
  { what: 'a key that collides with another token\'s symbol', input: 'gold', expect: { token: 'gold' } },
  { what: 'the same collision in upper case', input: 'GOLD', expect: { token: 'gold' } },

  // Neither namespace.
  { what: 'a name in neither namespace', input: 'nope', expect: { refuse: 'unknown' } },
  { what: 'a symbol from another deployment', input: 'ETH', expect: { refuse: 'unknown' } },

  // Not a string at all. A model that sends `{"token": 4}` is told what a token
  // is, not that token 4 does not exist.
  { what: 'a number', input: 4, expect: { refuse: 'invalid' } },
  { what: 'an object', input: { key: 'play' }, expect: { refuse: 'invalid' } },
  { what: 'an array', input: ['play'], expect: { refuse: 'invalid' } },
  { what: 'a boolean', input: true, expect: { refuse: 'invalid' } },
];
