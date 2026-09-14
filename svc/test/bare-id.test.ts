// §5: a bare id resolves within the caller's own namespace, and nowhere else.
//
// dana was shown `attacker` by the mesh, the registry holds `acme:attacker`,
// and returning an unsolicited bribe failed on the gap between the id a model
// SEES and the id the registry HOLDS. The MCP worked and the persona worked;
// the boundary refused a correct intent.
//
// Every test here is a vector from the spec, and the two that matter most are
// the REFUSALS: `ambiguous_name` is what stops a vanity squat redirecting
// in-namespace payments, and the bare-id counter is what stops this rule from
// silently deleting the only detector of a persona that never learned the
// convention.

import { describe, it, expect } from 'bun:test';
import { resolveBareName, type Resolved } from '../src/resolver.ts';
import { HttpError } from '../src/errors.ts';

const addr = (n: string) => `0x${n.repeat(40).slice(0, 40)}` as `0x${string}`;

/// A registry as a plain map, so a vector reads as the state of the world
/// rather than as a stub with behaviour.
///
/// ADDRESSES DIFFER BY CANONICAL, and that is load-bearing rather than tidy.
/// The first version returned one address for every name, so it could not
/// express "two names, one wallet" - and the ambiguity test passed whether the
/// rule compared addresses or merely counted readings. A fixture too uniform to
/// express the difference makes the test of that difference vacuous.
///
/// `null` as the value means "registered, canonical unknown" and still gets an
/// address of its own; two entries with the SAME canonical share an address,
/// which is how a wallet aliasing itself is written.
function registry(entries: Record<string, string | null>) {
  const addressFor = (canonical: string | null, name: string) =>
    addr(String((canonical ?? name).length % 9 || 1));
  return async (name: string): Promise<Resolved | null> =>
    name in entries
      ? { address: addressFor(entries[name] ?? null, name), canonical: entries[name] ?? null }
      : null;
}

const codeOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'no-throw';
  } catch (err) {
    return err instanceof HttpError ? err.code : `not-http: ${(err as Error).message}`;
  }
};

describe('bare ids resolve in the caller own namespace', () => {
  it('resolves a bare peer through the namespace, reporting own_namespace', async () => {
    const r = await resolveBareName(registry({ 'acme:toby': 'acme:toby' }), 'toby', 'acme');
    expect(r.canonical).toBe('acme:toby');
    expect(r.resolvedVia).toBe('own_namespace');
    expect(r.bare).toBe(true);
  });

  // An exactly registered name always wins, so this rule can never redirect a
  // name that already resolves.
  it('prefers an exactly registered name, reporting exact', async () => {
    const r = await resolveBareName(registry({ 'treasury.vee': 'treasury.vee' }), 'treasury.vee', 'acme');
    expect(r.canonical).toBe('treasury.vee');
    expect(r.resolvedVia).toBe('exact');
  });

  // THE REFUSAL THE FALLBACK IS PAID FOR. Whoever registers the vanity alias
  // `toby` would otherwise receive every in-namespace payment meant for
  // `acme:toby` - a phishing primitive on the money path.
  it('REFUSES when both readings exist, rather than picking either', async () => {
    const both = registry({ toby: 'alpha:squatter', 'acme:toby': 'acme:toby' });
    expect(await codeOf(() => resolveBareName(both, 'toby', 'acme'))).toBe('ambiguous_name');
  });

  // A WALLET ALIASING ITSELF IS NOT AMBIGUOUS. `acme:toby` registering the
  // alias `toby` makes both readings resolve to THE SAME wallet - ordinary,
  // harmless, and exactly what a persona would do to be addressable by the id
  // its peers see.
  //
  // Refusing it produced a 409 whose advice named one id twice, raised a
  // chain.name_collision against an agent that had done nothing, and - the part
  // that matters - would have refused this rule's own motivating case: had
  // `acme:attacker` aliased itself `attacker`, dana's return would have been
  // refused by the change written so it would not be.
  it('is NOT ambiguous when both readings are the same wallet', async () => {
    const selfAliased = registry({ toby: 'acme:toby', 'acme:toby': 'acme:toby' });
    const r = await resolveBareName(selfAliased, 'toby', 'acme');
    expect(r.canonical).toBe('acme:toby');
    expect(r.resolvedVia).toBe('exact'); // the registered name wins; nothing refuses
  });

  // The mutant the spec asks for by name: picking EITHER candidate is the bug.
  it('names both candidates in the refusal, so neither can be guessed silently', async () => {
    const both = registry({ toby: 'alpha:squatter', 'acme:toby': 'acme:toby' });
    let detail = '';
    try { await resolveBareName(both, 'toby', 'acme'); } catch (e) { detail = (e as HttpError).detail ?? ''; }
    expect(detail).toContain('alpha:squatter');
    expect(detail).toContain('acme:toby');
  });

  // ADDRESSES, NOT CANONICALS, and this is the vector that proves which.
  //
  // A BURNER REGISTERS NO NAMES, so its canonical is null (spec S4). Two
  // different burners therefore have the SAME canonical - null - and comparing
  // canonicals would call them one wallet and let the payment through to
  // whichever the fallback found. Comparing addresses refuses, correctly.
  //
  // Measured: with only the self-alias test above, swapping the comparison to
  // `exact.canonical !== peer.canonical` survived - because that fixture
  // derives each address FROM its canonical, so the two comparisons agree on
  // every vector it can express. This is the one it cannot.
  it('refuses two DIFFERENT wallets that both have no canonical name', async () => {
    const burners = registry({ ghost: null, 'acme:ghost': null });
    expect(await codeOf(() => resolveBareName(burners, 'ghost', 'acme'))).toBe('ambiguous_name');
  });

  // NEVER CROSS-NAMESPACE. A qualified id resolves exactly as it always did.
  it('does not reach into another namespace for a bare id', async () => {
    const other = registry({ 'alpha:client': 'alpha:client' });
    expect(await codeOf(() => resolveBareName(other, 'client', 'orch'))).toBe('unknown_name');
  });

  it('leaves a qualified id resolving exactly as before', async () => {
    const r = await resolveBareName(registry({ 'alpha:x': 'alpha:x' }), 'alpha:x', 'orch');
    expect(r.resolvedVia).toBe('exact');
    expect(r.bare).toBe(false);
  });

  // THE CASE EDGE. Canonical ids are lowercase-only; aliases preserve case for
  // the lookalike mechanic. `acme:aIpha` is not a canonical id, so path (2) is
  // SKIPPED - never lowercased (it would key money under an id the caller did
  // not ask for) and never a 400 (that would blame the caller for a string the
  // server built).
  it('skips the fallback for a bare form that cannot be a local id', async () => {
    let detail = '';
    const seen: string[] = [];
    const lookup = async (n: string) => { seen.push(n); return null; };
    try { await resolveBareName(lookup, 'aIpha', 'acme'); } catch (e) { detail = (e as HttpError).detail ?? ''; }
    expect(seen).toEqual(['aIpha']);          // acme:aIpha was never constructed
    expect(detail).toContain('not a valid local id');
  });

  // DO NOT FLATTEN, on the failure side: a student who reads "no wallet is
  // registered as toby" while `acme:toby` sits in the registry goes hunting a
  // registration bug that does not exist.
  it('names BOTH attempts when neither resolves', async () => {
    let detail = '';
    try { await resolveBareName(registry({}), 'toby', 'acme'); } catch (e) { detail = (e as HttpError).detail ?? ''; }
    expect(detail).toContain('toby');
    expect(detail).toContain('acme:toby');
  });
});

// ── The two instruments §5 requires ────────────────────────────────────────
//
// This rule DELETED A DETECTOR: `unknown_name` was the only signal that a
// persona addresses peers by the id it SEES rather than the id the registry
// HOLDS. Accepting the untaught form silences it, so a persona that never
// learns would produce no signal at all - the same shape as on-chain dedupe
// silencing chain.anomaly (§4). These are what replace it, and the four cases
// below are the spec's own.

import { Store } from '../src/store.ts';
import { Treasury } from '../src/treasury.ts';
import { loadPolicyDefaults } from '../src/policy.ts';
import type { Chain } from '../src/chain.ts';
import type { Keystore } from '../src/keystore.ts';
import type { Resolver } from '../src/resolver.ts';
import type { Config } from '../src/config.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG = new URL('..', import.meta.url).pathname;
const DEFAULTS = loadPolicyDefaults(join(PKG, 'policy-defaults.json'), 'vee');

function detector(entries: Record<string, string | null>) {
  const dir = mkdtempSync(join(tmpdir(), 'bareid-'));
  writeFileSync(
    join(dir, 'acme%3Adana.json'),
    JSON.stringify({
      agentId: 'acme:dana', max_per_tx: 1000, max_per_stage: 5000,
      allow: ['*'], deny: [], frozen: false,
    }),
  );
  const store = new Store(':memory:');
  store.markSpawned('acme:dana', addr('9'), null);
  const lookup = registry(entries);
  const t = new Treasury(
    { policyDir: dir, policyDefaultsPath: join(PKG, 'policy-defaults.json') } as Config,
    {
      viemChain: {},
      deployment: {}, modules: { tokens: [{ key: 'vee', address: '0x0', symbol: 'VEE', decimals: 18 }] },
      publicClient: { waitForTransactionReceipt: async () => ({}) },
      walletClient: { writeContract: async () => '0xsent' },
    } as unknown as Chain,
    { load: async () => ({ privateKey: `0x${'11'.repeat(32)}`, address: addr('9') }) } as unknown as Keystore,
    store,
    { lookup, require: async (n: string) => (await lookup(n))! } as unknown as Resolver,
    DEFAULTS,
  );
  return { t, store };
}

const send = (t: Treasury, to: string, intentId: string) =>
  t.signTransfer({ scope: 'wallet', agentId: 'acme:dana' }, { to, vee: '1', intentId });

describe('the bare-id detector', () => {
  // CASE 1 of 4: a legitimate colon-less platform name. Using it is CORRECT, so
  // it must not read as ignorance - this is why the counter keys on "not an
  // exactly registered name" rather than on "no colon".
  it('does not count an exactly registered colon-less name', async () => {
    const { t, store } = detector({ 'treasury.vee': 'treasury.vee' });
    await send(t, 'treasury.vee', 'i1').catch(() => undefined);
    expect(store.bareIdCount('acme:dana')).toBe(0);
    store.close();
  });

  // CASE 2: mixed case, so the fallback is skipped for shape. Still the
  // untaught form, so it still counts - the counter measures the BEHAVIOUR, not
  // one of its outcomes.
  it('counts a bare id whose fallback was skipped for shape', async () => {
    const { t, store } = detector({});
    await send(t, 'aIpha', 'i2').catch(() => undefined);
    expect(store.bareIdCount('acme:dana')).toBe(1);
    store.close();
  });

  // THE DETECTOR HAS TO ARRIVE, NOT ACCUMULATE. A column with no route, no
  // event and no consumer is not a signal - it is a value someone would have to
  // open the store to find, which is not what `unknown_name` was traded for.
  // So this asserts the EVENT, which is the part that reaches a facilitator;
  // the column is only the durable count behind it.
  it('DELIVERS the bare-id signal through the outbox, not just the column', async () => {
    const { t, store } = detector({ 'acme:toby': 'acme:toby' });
    await send(t, 'toby', 'e1').catch(() => undefined);

    const events = store.dueEvents(10).filter((e) => e.kind === 'chain.bare_id');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as {
      agentId: string; bare: string; outcome: string; count: number;
    };
    expect(payload.agentId).toBe('acme:dana');
    expect(payload.bare).toBe('toby');
    expect(payload.outcome).toBe('own_namespace');
    // The running total travels with the event, so the trend is visible without
    // querying the store at all.
    expect(payload.count).toBe(1);
    store.close();
  });

  // TWO sends, because one cannot tell a running total from a constant.
  // Measured: with only the single-send test above, hardcoding `count: 1`
  // survived - the third fixture in this PR too uniform to express the
  // difference it was supposed to be testing.
  it('carries a RUNNING total, not a constant', async () => {
    const { t, store } = detector({ 'acme:toby': 'acme:toby' });
    await send(t, 'toby', 'e1a').catch(() => undefined);
    await send(t, 'toby', 'e1b').catch(() => undefined);

    const counts = store
      .dueEvents(10)
      .filter((e) => e.kind === 'chain.bare_id')
      .map((e) => (JSON.parse(e.payload) as { count: number }).count);
    expect(counts).toEqual([1, 2]);
    store.close();
  });

  // THE TWO MISSES ARE DIFFERENT FACTS AND THE EVENT NOW SAYS WHICH.
  //
  // Both reach `unknown_name`, and the first version of this detector reported
  // both as `unresolved` - flattening, in the instrument built to replace a
  // detector. `unknown` means the fallback was TRIED and nobody holds the name;
  // `shape_skipped` means the bare form could never be a local id, so it was
  // never tried at all. A facilitator reading the timeline could not tell a
  // persona that mistyped a name from one that does not know ids are lowercase.
  //
  // Worse, under the refusal-code map `unknown_name` reaches the PERSONA with
  // the both-attempts detail - so the distinction was disclosed to the party
  // being socially engineered and withheld from the auditor watching. The
  // attacker's view was strictly better than the facilitator's.
  it('marks a tried-and-missed fallback as unknown', async () => {
    const { t, store } = detector({});
    await send(t, 'ghost', 'e2').catch(() => undefined);
    const events = store.dueEvents(10).filter((e) => e.kind === 'chain.bare_id');
    expect(events).toHaveLength(1);
    expect((JSON.parse(events[0]!.payload) as { outcome: string }).outcome).toBe('unknown');
    store.close();
  });

  it('marks a fallback skipped for shape as shape_skipped, not unknown', async () => {
    const { t, store } = detector({});
    // Mixed case: `acme:aIpha` is not a canonical id, so the candidate is
    // never constructed and the fallback is never attempted.
    await send(t, 'aIpha', 'e2b').catch(() => undefined);
    const events = store.dueEvents(10).filter((e) => e.kind === 'chain.bare_id');
    expect(events).toHaveLength(1);
    expect((JSON.parse(events[0]!.payload) as { outcome: string }).outcome).toBe('shape_skipped');
    store.close();
  });

  // The taught form must stay silent, or the facilitator's timeline fills with
  // agents doing it right.
  it('emits NOTHING for a qualified id', async () => {
    const { t, store } = detector({ 'acme:toby': 'acme:toby' });
    await send(t, 'acme:toby', 'e3').catch(() => undefined);
    expect(store.dueEvents(10).filter((e) => e.kind === 'chain.bare_id')).toHaveLength(0);
    store.close();
  });

  // CASE 3: the case that used to fail with unknown_name and now succeeds.
  it('counts a bare id that the namespace fallback resolved', async () => {
    const { t, store } = detector({ 'acme:toby': 'acme:toby' });
    await send(t, 'toby', 'i3').catch(() => undefined);
    expect(store.bareIdCount('acme:dana')).toBe(1);
    store.close();
  });

  // CASE 4: the squat. NOT counted - the bare form IS an exactly registered
  // name - and SIGNALLED instead, because the evidence is about the registrant
  // rather than the sender's competence. Folding it into the counter would put
  // two meanings in one number, re-merging what §4's repeat_emission /
  // foreign_sender split keeps apart.
  it('does not count an ambiguity, and emits a collision signal naming both', async () => {
    const { t, store } = detector({ toby: 'alpha:squatter', 'acme:toby': 'acme:toby' });
    const code = await codeOf(() => send(t, 'toby', 'i4'));
    expect(code).toBe('ambiguous_name');
    expect(store.bareIdCount('acme:dana')).toBe(0);

    const events = store.dueEvents(10).filter((e) => e.kind === 'chain.name_collision');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as { bare: string; candidates: unknown[] };
    expect(payload.bare).toBe('toby');
    expect(payload.candidates).toHaveLength(2);
    store.close();
  });

  // A bare miss counts too: it is exactly what `unknown_name` was detecting
  // before this rule, and the detector must keep firing where it used to.
  it('counts a bare id that resolved to nothing', async () => {
    const { t, store } = detector({});
    await send(t, 'ghost', 'i5').catch(() => undefined);
    expect(store.bareIdCount('acme:dana')).toBe(1);
    store.close();
  });

  // A QUALIFIED id is the taught form. It must never count, or the detector
  // reads highest for the personas that learned.
  it('never counts a qualified id', async () => {
    const { t, store } = detector({ 'acme:toby': 'acme:toby' });
    await send(t, 'acme:toby', 'i6').catch(() => undefined);
    expect(store.bareIdCount('acme:dana')).toBe(0);
    store.close();
  });
});
