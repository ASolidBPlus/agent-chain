// §2. CAPS PER TOKEN.
//
// A wallet's caps stop being two numbers and become a map keyed by token key.
// The shape is the easy half; the rules around its EDGES are the half that
// decides whether money is bounded:
//
//   - a token with NO entry cannot be spent, because silence must fail closed
//     in money policy. The alternative - an absent cap meaning "no limit" - is
//     the one reading that costs money, and it is the reading a reader reaches
//     for first.
//   - `*` in policy-defaults.json is expanded to every DEPLOYED token key at
//     load, so a deployment that adds a token does not silently give every
//     wallet an unbounded new currency, nor a bounded-by-nothing one.
//   - an explicit key REPLACES the whole pair rather than merging field by
//     field, so "au gets a bigger max_per_tx" cannot accidentally inherit vee's
//     max_per_stage - two halves of one bound, from two different currencies.
//
// The legacy shape is read and migrated IN MEMORY rather than refused: a store
// full of v0.4.0 policy files is the ordinary upgrade, and refusing them would
// freeze every wallet in a running game.

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capsFor,
  loadPolicyDefaults,
  mergePolicy,
  normalisePolicy,
  droppedPatternsLogged,
  type AgentPolicy,
} from '../src/policy.ts';
import { HttpError } from '../src/errors.ts';

const TOKENS = ['vee', 'au'];

function defaultsFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'caps-defaults-'));
  const path = join(dir, 'policy-defaults.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const KIND = (caps: unknown) => ({ caps, allow: ['*'], deny: [] });

const FILE = (over: Record<string, unknown> = {}) => ({
  org: KIND({ '*': { max_per_tx: '1000', max_per_stage: '5000' } }),
  agent: KIND({ '*': { max_per_tx: '100', max_per_stage: '500' } }),
  burner: KIND({ '*': { max_per_tx: '50', max_per_stage: '200' } }),
  ...over,
});

describe('capsFor', () => {
  const policy: AgentPolicy = {
    caps: { vee: { max_per_tx: '100', max_per_stage: '500' } },
    allow: ['*'],
    deny: [],
  };

  it('finds the caps for a token the wallet has', () => {
    expect(capsFor(policy, 'vee')).toEqual({ max_per_tx: '100', max_per_stage: '500' });
  });

  it('REFUSES a token the wallet has no entry for', () => {
    // Silence fails CLOSED. An absent cap read as "no limit" is the one reading
    // that costs money, and it is the reading a careless caller reaches for.
    let err: unknown;
    try {
      capsFor(policy, 'au');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('over_max_per_tx');
    expect((err as HttpError).detail).toBe('no cap set for au');
  });

  it('refuses even when the entry exists but is empty', () => {
    expect(() => capsFor({ ...policy, caps: { au: {} as never } }, 'au')).toThrow(HttpError);
  });
});

describe('loadPolicyDefaults with per-token caps', () => {
  it('expands * to every deployed token key', () => {
    const d = loadPolicyDefaults(defaultsFile(FILE()), 'play', TOKENS, () => {});
    expect(Object.keys(d.agent.caps).sort()).toEqual(['au', 'vee']);
    expect(d.agent.caps.vee).toEqual({ max_per_tx: '100', max_per_stage: '500' });
    expect(d.agent.caps.au).toEqual({ max_per_tx: '100', max_per_stage: '500' });
  });

  it('lets an explicit key REPLACE the pair, not merge into it', () => {
    // Field-by-field merging is the trap: "au gets a bigger max_per_tx" would
    // silently inherit vee's max_per_stage, and the wallet would carry two
    // halves of one bound taken from two different currencies.
    const d = loadPolicyDefaults(
      defaultsFile(
        FILE({
          agent: KIND({
            '*': { max_per_tx: '100', max_per_stage: '500' },
            au: { max_per_tx: '1000', max_per_stage: '9000' },
          }),
        }),
      ),
      'play',
      TOKENS,
      () => {},
    );
    expect(d.agent.caps.vee).toEqual({ max_per_tx: '100', max_per_stage: '500' });
    expect(d.agent.caps.au).toEqual({ max_per_tx: '1000', max_per_stage: '9000' });
  });

  it('refuses an explicit key that is not a deployed token', () => {
    // At LOAD, where the operator who wrote it is looking. A key naming a token
    // that is not there is a cap that will never be consulted, and the author
    // believes it will.
    expect(() =>
      loadPolicyDefaults(
        defaultsFile(FILE({ agent: KIND({ '*': { max_per_tx: '1', max_per_stage: '2' }, xau: { max_per_tx: '1', max_per_stage: '2' } }) })),
        'play',
        TOKENS,
        () => {},
      ),
    ).toThrow(/caps names "xau", not a deployed token/);
  });

  it('refuses a caps key that is a glob other than *', () => {
    // EXACTLY TWO KEY FORMS, `*` and a token key. A third - `a*`, `*u` - would
    // make the file a pattern language, and the one place this system has a
    // pattern language (allow/deny) is the one place it has needed a rule about
    // what a pattern that matches nothing means.
    expect(() =>
      loadPolicyDefaults(
        defaultsFile(FILE({ agent: KIND({ 'a*': { max_per_tx: '1', max_per_stage: '2' } }) })),
        'play',
        TOKENS,
        () => {},
      ),
    ).toThrow(/caps names "a\*"/);
  });

  it('refuses a kind whose caps set no token at all', () => {
    // An empty caps map is a wallet that can spend nothing. That may be
    // deliberate for a kind, but it is not something to arrive at by leaving a
    // key out of a file, so it has to be written as such.
    expect(() =>
      loadPolicyDefaults(defaultsFile(FILE({ agent: KIND({}) })), 'play', TOKENS, () => {}),
    ).toThrow(/agent/);
  });

  it('refuses a cap that is not a usable amount', () => {
    for (const bad of [{ max_per_tx: '0', max_per_stage: '5' }, { max_per_tx: '-1', max_per_stage: '5' }, { max_per_tx: 'lots', max_per_stage: '5' }, { max_per_stage: '5' }]) {
      expect(() =>
        loadPolicyDefaults(defaultsFile(FILE({ agent: KIND({ '*': bad }) })), 'play', TOKENS, () => {}),
      ).toThrow();
    }
  });

  it('still drops TLD patterns on a names-less deployment', () => {
    // The {tld} substitution is UNCHANGED and lives beside the caps expansion
    // rather than inside it: they answer different questions and the first has
    // its own rule about what a pattern matching nothing means.
    //
    // SAVED AND RESTORED, not merely cleared. `droppedPatternsLogged` is
    // PROCESS-WIDE and another file's test asserts the once-per-process
    // property across two of its own loads - so a bare `clear()` here makes
    // that test pass or fail depending on which file bun happened to run in
    // between. Owning the state means putting it back.
    const saved = [...droppedPatternsLogged];
    droppedPatternsLogged.clear();
    const lines: string[] = [];
    const d = loadPolicyDefaults(
      defaultsFile(FILE({ agent: { caps: { '*': { max_per_tx: '1', max_per_stage: '2' } }, allow: ['*.{tld}'], deny: ['treasury.{tld}'] } })),
      undefined,
      TOKENS,
      (m) => lines.push(m),
    );
    expect(d.agent.allow).toEqual([]);
    expect(lines.join('\n')).toMatch(/names a TLD/);

    droppedPatternsLogged.clear();
    for (const p of saved) droppedPatternsLogged.add(p);
  });

  it('expands to NOTHING on a deployment with no tokens, without inventing one', () => {
    // A names-only deployment has no token to cap. The caps map is empty, and
    // every spend is refused by capsFor - which is correct, because there is
    // nothing to spend.
    const d = loadPolicyDefaults(defaultsFile(FILE()), 'play', [], () => {});
    expect(d.agent.caps).toEqual({});
  });
});

describe('the legacy policy shape', () => {
  const legacy = { max_per_tx: '100', max_per_stage: '500', allow: ['*.play'], deny: ['treasury.play'] };

  it('is read as caps for the DEFAULT token', () => {
    // A store full of v0.4.0 policy files is the ordinary upgrade. Refusing
    // them would freeze every wallet in a running game, and inventing a
    // per-token split would invent a bound nobody wrote.
    const p = normalisePolicy(legacy, 'vee');
    expect(p.caps).toEqual({ vee: { max_per_tx: '100', max_per_stage: '500' } });
    expect(p.allow).toEqual(['*.play']);
  });

  it('leaves a new-shape policy alone', () => {
    const modern = { caps: { au: { max_per_tx: '1', max_per_stage: '2' } }, allow: [], deny: [] };
    expect(normalisePolicy(modern, 'vee')).toEqual(modern);
  });

  it('refuses a document that is neither shape', () => {
    for (const bad of [{ allow: [], deny: [] }, { caps: 'lots', allow: [], deny: [] }, null, 'policy']) {
      expect(() => normalisePolicy(bad, 'vee')).toThrow();
    }
  });

  it('prefers caps when a file somehow carries both shapes', () => {
    // A half-migrated file: written by a new binary, edited by hand from an old
    // example. The NEW shape wins, because it is the one that can express what
    // the old one cannot, and silently preferring the legacy pair would discard
    // every token but the default.
    const both = { ...legacy, caps: { au: { max_per_tx: '7', max_per_stage: '9' } } };
    expect(normalisePolicy(both, 'vee').caps).toEqual({ au: { max_per_tx: '7', max_per_stage: '9' } });
  });
});

describe('mergePolicy with caps', () => {
  const defaults: AgentPolicy = {
    caps: { vee: { max_per_tx: '100', max_per_stage: '500' }, au: { max_per_tx: '10', max_per_stage: '50' } },
    allow: ['*.play'],
    deny: ['treasury.play'],
  };

  it('falls to the kind defaults when no policy is supplied', () => {
    expect(mergePolicy(undefined, defaults)).toEqual(defaults);
  });

  it('takes a supplied caps map WHOLE, replacing the defaults', () => {
    // The same rule as the defaults file's explicit key, one level up: a
    // supplied caps map is what this wallet may spend, not an amendment to what
    // its kind may. Merging would let a caller widen one token by naming
    // another.
    const merged = mergePolicy({ caps: { au: { max_per_tx: '1', max_per_stage: '2' } } }, defaults);
    expect(merged.caps).toEqual({ au: { max_per_tx: '1', max_per_stage: '2' } });
    expect(merged.allow).toEqual(['*.play']);
  });

  it('accepts the legacy pair from a caller and reads it as the default token', () => {
    const merged = mergePolicy({ max_per_tx: '7' }, defaults, 'vee');
    expect(merged.caps.vee).toEqual({ max_per_tx: '7', max_per_stage: '500' });
    // The OTHER token's defaults survive: a caller writing the legacy shape is
    // saying something about the default token, not about every token.
    expect(merged.caps.au).toEqual({ max_per_tx: '10', max_per_stage: '50' });
  });

  it('refuses a cap that is not an amount, in either shape', () => {
    expect(() => mergePolicy({ max_per_tx: 25.5 }, defaults, 'vee')).toThrow(HttpError);
    expect(() => mergePolicy({ caps: { vee: { max_per_tx: 25.5, max_per_stage: '5' } } }, defaults)).toThrow(
      HttpError,
    );
  });

  it('refuses caps naming a token with no pair', () => {
    expect(() => mergePolicy({ caps: { vee: 'lots' } }, defaults)).toThrow(HttpError);
  });
});
