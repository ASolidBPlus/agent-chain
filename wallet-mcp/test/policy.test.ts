import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UNLIMITED,
  capsRefusal,
  checkLocally,
  normaliseVee,
  veeToWei,
  matchesPattern,
  readPolicy,
  type WalletPolicy,
} from '../src/policy.ts';
import { WalletStore } from '../src/store.ts';
import { REFUSAL_FOR } from '../src/wallet.ts';

// The RESOLVED TOKEN is threaded in as one value (spec S3): key and decimals
// are two facts about one token, and passing them apart is what lets an amount
// be scaled by one token's precision and capped under another's name.
//
// Two tokens, and they disagree in every dimension the code filters on - key,
// symbol, caps, decimals. A fixture whose tokens differ in only one of those
// passes against a guard that reads the wrong one of the other three.
const PLAY = { key: 'play', decimals: 18 };
const GOLD = { key: 'au', decimals: 6 };

// These cases exercise the 18-place token, so they pin it at the call rather
// than repeating it fifteen times; the per-token cases below name their own.
//
// The REASON alone, because that is what these cases are about. `checkLocally`
// returns `{reason, detail?}` since the capless path needs to say which token
// it found no cap for, and the detail has its own cases further down.
const chk = (policy: WalletPolicy | null, to: string, vee: string, token = PLAY) =>
  checkLocally(policy, to, vee, token)?.reason ?? null;
const wei = (vee: string) => veeToWei(vee, 18);

const POLICY: WalletPolicy = {
  agentId: 'orch:vendor',
  caps: {
    play: { max_per_tx: 100, max_per_stage: 500 },
    au: { max_per_tx: 5, max_per_stage: 20 },
  },
  allow: ['*.play'],
  deny: ['treasury.play'],
};

describe('pattern matching', () => {
  it('uses the same restricted dialect as chain-svc', () => {
    expect(matchesPattern('*', 'anything')).toBe(true);
    expect(matchesPattern('*.play', 'alpha.play')).toBe(true);
    expect(matchesPattern('*.play', 'alpha.playx')).toBe(false);
    expect(matchesPattern('treasury.play', 'treasury.play')).toBe(true);
  });
});

describe('the local pre-check', () => {
  it('refuses over max_per_tx, a denied counterparty, and a frozen wallet', () => {
    expect(chk(POLICY, 'alpha.play', '150')).toBe('over_max_per_tx');
    expect(chk(POLICY, 'treasury.play', '1')).toBe('counterparty_denied');
    // `frozen` left the policy document at v0.8.0: the service-side lock is
    // retirement, written to its own table by `retire()` alone and never to a
    // wallet's policy file. There is nothing local to pre-check, so a retired
    // wallet's send is refused at the boundary and reaches a persona as the
    // generic error - `wallet_retired` is withheld, because a retired wallet
    // has no persona left to read it.
  });

  it('refuses a counterparty no allow rule covers', () => {
    expect(chk({ ...POLICY, allow: [] }, 'alpha.play', '1')).toBe('counterparty_denied');
    expect(chk(POLICY, 'alpha.wat', '1')).toBe('counterparty_denied');
  });

  it('passes a send nothing local objects to', () => {
    expect(chk(POLICY, 'alpha.play', '100')).toBeNull();
  });

  // Deliberate: the stage cap counts spends since the last stage change, and
  // this process has no stage source - hub-core's /session needs a platform
  // credential, which by design never reaches the agent side. So the refusal
  // comes from chain-svc, which is the authority anyway.
  it('does not attempt the stage cap locally', () => {
    expect(chk(POLICY, 'alpha.play', '100')).toBeNull();
  });

  // An unreadable policy is NOT permission and NOT a refusal: chain-svc decides.
  // Returning 'frozen' here would strand an agent on a transient read error;
  // approving would be worse.
  it('defers to chain-svc when the policy cannot be read', () => {
    expect(chk(null, 'alpha.play', '999999')).toBeNull();
  });
});

// §3. Every guard below reads the token it was GIVEN. The fixture's two tokens
// disagree in key, symbol, caps and decimals, so a guard that reaches for the
// default, for the first entry, or for the wrong precision produces a different
// answer here rather than the same one.
describe('caps are per token', () => {
  it('applies the named token\'s cap, not the other one\'s', () => {
    // 10 is under PLAY's cap of 100 and over GOLD's of 5. One amount, one
    // policy, two answers - which is the whole point of the map.
    expect(chk(POLICY, 'alpha.play', '10')).toBeNull();
    expect(chk(POLICY, 'alpha.play', '10', GOLD)).toBe('over_max_per_tx');
  });

  it('scales the amount by the named token\'s decimals', () => {
    // GOLD is six places. Scaled by eighteen, "5" would compare as 5e18 against
    // a cap of 5e6 and refuse a send that is exactly at the cap; scaled by six,
    // both sides are 5e6.
    expect(chk(POLICY, 'alpha.play', '5', GOLD)).toBeNull();
    expect(chk(POLICY, 'alpha.play', '5.000001', GOLD)).toBe('over_max_per_tx');
    // And the fraction that only exists at eighteen places is below GOLD's
    // resolution entirely, so it is not over the cap - it truncates to 5.
    expect(chk(POLICY, 'alpha.play', '5.0000000001', GOLD)).toBeNull();
  });

  // FLIPPED at v0.8.0: silence about a token is no rule about it. The old row
  // refused here on the argument that an absent cap read as "no limit" is the
  // only reading that costs money; the owner reversed it, and the bounds that
  // must survive a bypass live in the contracts rather than in this file.
  it('does not refuse a token the policy says nothing about', () => {
    const only = { ...POLICY, caps: { play: { max_per_tx: 100, max_per_stage: 500 } } };
    expect(checkLocally(only, 'alpha.play', '1', GOLD)).toBeNull();
    // ...while the token it DOES cover is still bounded, which is what keeps
    // this a statement about absence rather than about the check being off.
    expect(chk(only, 'alpha.play', '101')).toBe('over_max_per_tx');
  });

  // The map is chain-svc's, and chain-svc's bookkeeping stores KEYS. A policy
  // keyed by the symbol caps nothing - which is why the fixture's symbol is not
  // its key upper-cased: keyed by symbol, this test would pass by coincidence.
  it('reads the map by key, never by symbol', () => {
    const bySymbol = { ...POLICY, caps: { GOLD: { max_per_tx: 5, max_per_stage: 20 } } };
    // `no_cap_set`, NOT `over_max_per_tx`: a policy keyed by symbol caps
    // nothing, so the refusal this asserts is the no-cap one. The test is NAMED
    // for key/symbol resolution and a classifier reading names files it under
    // resolution and leaves it on the old code - the disposition is decided by
    // what the FIXTURE makes true, never by the title.
    // A policy keyed by SYMBOL caps nothing under key `au`, and at v0.8.0
    // capping nothing is no refusal. The key/symbol property is asserted on the
    // bound instead: looked up by KEY the entry is absent (unbounded), and the
    // same entry read under its written key `GOLD` is found and BOUNDS at 5 -
    // so a reader that matched symbols would refuse the 1 below.
    expect(chk(bySymbol, 'alpha.play', '1', GOLD)).toBeNull();
    expect(capsRefusal(bySymbol, 'au')).toBeNull();
    expect(capsRefusal(bySymbol, 'GOLD')).toBeNull();
  });

  // `*` IS NOT A WILDCARD HERE, and that is the boundary's rule, not a gap.
  // chain-svc's policy-defaults.json may write `caps: {"*": ...}`, but it
  // EXPANDS that to one entry per deployed token at load - what reaches a
  // wallet's policy file is always explicit keys. Its own `capsFor` does not
  // read `*` either, so a reader that did would grant here what the boundary
  // refuses: the local check would pass and /sign-transfer would reject, which
  // reads to a persona as the platform being broken.
  it('does not treat a literal "*" entry as covering every token', () => {
    // FLIPPED in its assertion, unchanged in its point: `*` still covers
    // nothing. What an uncovered token means changed at v0.8.0 - unbounded
    // rather than refused - so the property is asserted by showing the bound
    // does NOT apply: 999 passes under `play`, which a wildcard reader would
    // have refused at 100.
    const wild = { ...POLICY, caps: { '*': { max_per_tx: 100, max_per_stage: 500 } } };
    expect(chk(wild, 'alpha.play', '999')).toBeNull();
    expect(capsRefusal(wild, 'play')).toBeNull();
  });

  // §1b. `"unlimited"` is a decision someone wrote down; silence is not. The two
  // must not collapse into each other in either direction, so both rows are
  // here and the fixture holds them side by side.
  it('accepts "unlimited" as a cap and skips only that bound', () => {
    const unl = {
      ...POLICY,
      caps: { play: { max_per_tx: UNLIMITED, max_per_stage: 500 } },
    } as unknown as WalletPolicy;

    // The per-tx bound is gone at any size...
    expect(chk(unl, 'alpha.play', '999999999')).toBeNull();
    // ...and it is NOT a cap-less policy: capsRefusal must still pass it, or
    // "unlimited" would refuse exactly like silence.
    expect(capsRefusal(unl, 'play')).toBeNull();
    // ...and the OTHER bound is untouched. Each field takes it independently,
    // so a test that set both could not tell one skip from two. At v0.8.0 an
    // absent second field is no longer a refusal, so the independence is shown
    // the other way round: written-unlimited per-tx with an absent stage bound
    // is a policy with NO refusals in it at all.
    expect(capsRefusal({ ...unl, caps: { play: { max_per_tx: UNLIMITED } } }, 'play')).toBeNull();
  });

  // THE FAIL-OPEN DIRECTION, which is the one that costs money. The
  // implementation to reach for is `typeof v === 'string' && !isNumeric(v)` ->
  // no bound, and it makes a TYPO an uncapped wallet.
  it('treats any other non-amount cap as ABSENT, never as unlimited', () => {
    // `undefined` LEAVES THIS LIST at v0.8.0 and is the whole reversal: it is
    // the one value in it that means "nobody wrote a bound" rather than "this
    // is unreadable". Everything else is PRESENT and unusable, and still fails
    // closed.
    for (const bad of ['unlimted', 'UNLIMITED', 'Unlimited', '', 'none', null, {}, -5, 0]) {
      const p = { ...POLICY, caps: { play: { max_per_tx: bad, max_per_stage: 500 } } } as unknown as WalletPolicy;
      expect(capsRefusal(p, 'play')?.reason).toBe('no_cap_set');
      // And it refuses the SEND too, rather than passing the bound.
      expect(chk(p, 'alpha.play', '1')).toBe('no_cap_set');
    }
    // THE ONE THAT MOVED, kept as its own row rather than deleted from the list:
    // an absent field is no bound, and reading it as garbage would re-impose
    // exactly the fail-closed-on-silence rule this release removes.
    const absent = { ...POLICY, caps: { play: { max_per_stage: 500 } } } as unknown as WalletPolicy;
    expect(capsRefusal(absent, 'play')).toBeNull();
    expect(chk(absent, 'alpha.play', '999999')).toBeNull();
    // The control: the exact string, and only it, is accepted.
    const ok = { ...POLICY, caps: { play: { max_per_tx: UNLIMITED, max_per_stage: UNLIMITED } } } as unknown as WalletPolicy;
    expect(capsRefusal(ok, 'play')).toBeNull();
  });

  // The empty string is the one non-amount value that did not throw:
  // `veeToWei('')` is 0, so `max_per_tx: ''` refused EVERY spend as a bare
  // `over_max_per_tx` - a bricked wallet whose message said the amount was too
  // large. It now says what is actually wrong.
  it('diagnoses an empty cap as no cap, not as an amount over the bound', () => {
    const empty = { ...POLICY, caps: { play: { max_per_tx: '', max_per_stage: 500 } } } as unknown as WalletPolicy;
    expect(checkLocally(empty, 'alpha.play', '1', PLAY)).toEqual({
      reason: 'no_cap_set',
      detail: 'max_per_tx for play is not a usable amount',
    });
  });

  // The NARROW function chain-svc's agreement test asserts against
  // (svc/test/policy.test.ts). It is asserted here on its own, not only through
  // checkLocally, because the agreement is about this one decision: a test that
  // reached it through the five-branch check would be hostage to that check's
  // internal ordering on both sides.
  it('capsRefusal answers for one token at a time', () => {
    expect(capsRefusal(POLICY, 'play')).toBeNull();
    expect(capsRefusal(POLICY, 'au')).toBeNull();
    // FLIPPED: a token with no entry is unbounded at v0.8.0, so there is
    // nothing to refuse about `nope`.
    expect(capsRefusal(POLICY, 'nope')).toBeNull();
    // A HALF-WRITTEN ENTRY BOUNDS THE HALF THAT IS WRITTEN. "Half-written" was
    // a category only while both fields were required; each stands alone now.
    const half = { ...POLICY, caps: { play: { max_per_stage: 500 } } };
    expect(capsRefusal(half, 'play')).toBeNull();
    // PER TOKEN STILL MEANS PER TOKEN, which is what this row is named for and
    // what the flips above would otherwise have emptied out: one unreadable
    // entry refuses its own token and leaves the others alone.
    const oneBad = { ...POLICY, caps: { play: { max_per_tx: 'lots' }, au: { max_per_tx: 5 } } } as never;
    expect(capsRefusal(oneBad, 'play')?.reason).toBe('no_cap_set');
    expect(capsRefusal(oneBad, 'au')).toBeNull();
  });
});

describe('reading the policy file', () => {
  it('reads a written policy and reports an unusable one as null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(POLICY));
    expect(readPolicy(good)?.caps?.play?.max_per_tx).toBe(100);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(readPolicy(bad)).toBeNull();
    expect(readPolicy(join(dir, 'missing.json'))).toBeNull();
  });

  // chain-svc rewrites this file to frozen:true when a wallet is retired, so a
  // cached copy would keep spending for the life of the process.
  it('sees a cap written after the process started', () => {
    // READ FRESH ON EVERY SEND, and this is the row that proves it. It used to
    // assert a freeze appearing mid-process; `frozen` left the document at
    // v0.8.0, so the property is asserted on a bound instead - the same
    // question about the same caching, on a field that still exists.
    const dir = mkdtempSync(join(tmpdir(), 'policy-'));
    const path = join(dir, 'p.json');
    writeFileSync(path, JSON.stringify(POLICY));
    expect(readPolicy(path)?.caps?.play?.max_per_tx).toBe(100);

    writeFileSync(path, JSON.stringify({ ...POLICY, caps: { play: { max_per_tx: 5 } } }));
    expect(readPolicy(path)?.caps?.play?.max_per_tx).toBe(5);
  });
});

// ruled: `vee` is a decimal string on every money wire. A whole NUMBER is
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
    expect(wei('12.5')).toBe(12_500_000_000_000_000_000n);
    expect(wei('1')).toBe(10n ** 18n);
    // The comparison the cap actually makes, at a value a float would fumble.
    expect(chk(POLICY, 'alpha.play', '100')).toBeNull();
    expect(chk(POLICY, 'alpha.play', '100.000000000000000001')).toBe('over_max_per_tx');
  });
});

// chain-svc WRITES this file and wallet-mcp READS it, so the reader must accept
// everything the writer emits. Caps became decimal strings (ruled); a
// reader still demanding numbers would reject every policy chain-svc produces
// and the model would see "no policy" - which fails OPEN to chain-svc's
// boundary rather than closed, so nothing would visibly break until a cap
// silently stopped being pre-checked.
describe('reading the policy chain-svc actually writes', () => {
  it('accepts STRING caps, per token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pol-'));
    const file = join(dir, 'policy.json');
    writeFileSync(
      file,
      JSON.stringify({
        agentId: 'orch:a',
        caps: {
          play: { max_per_tx: '25', max_per_stage: '100' },
          au: { max_per_tx: '2', max_per_stage: '8' },
        },
        allow: ['*.play'],
        deny: ['treasury.play'],
        frozen: false,
      }),
    );

    const policy = readPolicy(file);
    expect(policy).not.toBeNull();
    expect(policy!.caps!.play!.max_per_tx).toBe('25');
    // And the cap it read actually enforces, in wei rather than as a float.
    expect(chk(policy, 'bob.play', '26')).toBe('over_max_per_tx');
    expect(chk(policy, 'bob.play', '25')).toBeNull();
    // The OTHER token's cap, at its own precision: 2 GOLD is six places, and
    // scaling it by eighteen would put it four orders of magnitude over its cap.
    expect(chk(policy, 'bob.play', '2', GOLD)).toBeNull();
    expect(chk(policy, 'bob.play', '2.000001', GOLD)).toBe('over_max_per_tx');
  });

  it('still accepts numeric caps, so a hand-written file keeps working', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pol-'));
    const file = join(dir, 'policy.json');
    writeFileSync(
      file,
      JSON.stringify({
        agentId: 'orch:a',
        caps: { play: { max_per_tx: 25, max_per_stage: 100 } },
        allow: ['*.play'],
        deny: [],
        frozen: false,
      }),
    );
    expect(chk(readPolicy(file), 'bob.play', '26')).toBe('over_max_per_tx');
  });

  // The PRE-MULTI-TOKEN file, with flat caps and no `caps` map. It reads as
  // null, which means DEFER TO chain-svc - not "frozen", and not "no limit".
  // chain-svc owns the migration and rewrites the file; a second migration here
  // would be the same rule written twice, and failing closed instead would
  // freeze every wallet for the length of an ordinary upgrade.
  it('defers on a file written before caps were per token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pol-'));
    const file = join(dir, 'policy.json');
    writeFileSync(
      file,
      JSON.stringify({
        agentId: 'orch:a',
        max_per_tx: 25,
        max_per_stage: 100,
        allow: ['*.play'],
        deny: [],
        frozen: false,
      }),
    );
    expect(readPolicy(file)).toBeNull();
    expect(chk(readPolicy(file), 'bob.play', '999999')).toBeNull();
  });
});

// Rider 1: the tombstone invariant is chain-svc's AND this ledger's.
// A persona re-sending under a used id must meet the ORIGINAL outcome, and an
// entry that can disappear is one that stops answering.
describe('the intent ledger never forgets', () => {
  it('keeps an intent across later writes and a reload from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const file = join(dir, 'state.json');

    const first = new WalletStore(file);
    first.remember('a', { txHash: '0xaaa', vee: '10', to: 'bob.play', at: 1 });
    first.remember('b', { txHash: '0xbbb', vee: '20', to: 'carol.play', at: 2 });

    // Still there after another intent was written...
    expect(first.recall('a')?.txHash).toBe('0xaaa');
    // ...and after a restart, which is the case that matters: the process that
    // wrote it is gone and the persona retries against a fresh one.
    expect(new WalletStore(file).recall('a')?.txHash).toBe('0xaaa');
  });

  // The property stated as a shape rather than a behaviour, because the risk is
  // somebody ADDING a way to forget. If this fails, a delete/prune/expire has
  // been introduced and the invariant above needs re-reading first.
  it('exposes no way to remove an intent', () => {
    const store = new WalletStore(join(mkdtempSync(join(tmpdir(), 'ledger-')), 's.json'));
    for (const name of ['delete', 'remove', 'forget', 'prune', 'expire', 'clear']) {
      expect((store as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

// §8.10. THE SIZE OF THE PERSONA-FACING SET, as a test rather than as a grep in
// a PR body.
//
// A grep proves a string is present; it cannot prove the map still MEANS what
// the disclosure decision decided. This compares to a VALUE - the closed set,
// by name - so both directions are caught: a code quietly added to the
// persona-facing side, and one quietly removed from it. The count alone would
// catch neither if two changes cancelled.
describe('the disclosure decision', () => {
  // THE NUMBER IS OUT OF THE NAME, deliberately. It said "fourteen" and the
  // array said fourteen things, and the two could rot apart: update the array
  // and the title is a false statement that still passes. A title must not
  // carry a fact that can rot independently of the assertion under it - which
  // is the same reason the comment above prefers a VALUE to a count.
  it('discloses exactly this set, and nothing else', () => {
    const facing = Object.entries(REFUSAL_FOR)
      .filter(([, reason]) => reason !== null)
      .map(([code]) => code)
      .sort();

    expect(facing).toEqual(
      [
        // The persona's own wallet, policy or input...
        'over_max_per_tx',
        // APPENDED, NOT SUBSTITUTED. `over_max_per_tx` keeps the meaning where
        // a smaller amount would succeed; `no_cap_set` takes the one where none
        // would. Replacing rather than appending would delete a live
        // persona-facing code, and this test's red at that moment reads as "the
        // list is stale" - which invites making the list match the map and
        // cementing the deletion. A test that catches a mistake still needs the
        // reader to know which direction to fix it.
        'no_cap_set',
        'over_stage_cap',
        'counterparty_denied',
        'invalid_name',
        'invalid_amount',
        'bad_args',
        // ...the public registry...
        'unknown_name',
        'ambiguous_name',
        'unknown_contract',
        'unknown_token',
        'function_not_allowed',
        // ...and what its own action did.
        'intent_unresolved',
        'revert',
      ].sort(),
    );
  });

  it('keeps module_not_deployed generic, which is the deployment\'s shape', () => {
    // Withheld deliberately: it describes what the operator chose to run, which
    // is not the persona's business and is not something it can act on.
    expect(REFUSAL_FOR.module_not_deployed).toBeNull();
  });
});
