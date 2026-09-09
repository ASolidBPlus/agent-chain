// The authorisation model, unit level.
//
// There are deliberately TWO scope checks: one at the router (from the ROUTES
// table) and one inside each platform handler (requirePlatform). That is
// defence in depth and it is also exactly the co-satisfied-guards shape that
// has bitten this project three times - either check alone makes the
// end-to-end tests pass. So each is isolated here: the handler guard by
// calling it directly, and the router declaration by asserting the table.

import { describe, it, expect } from 'bun:test';
import { authenticate, assertMayRead, hashToken, requirePlatform, walletPrincipal, constantTimeEquals } from '../src/auth.ts';
import { ROUTES, assertRouteScope, type Route } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { HttpError } from '../src/errors.ts';
import { enforcePolicy, matchesPattern, stageCapWei } from '../src/policy.ts';
import type { AgentPolicy } from '../src/policy.ts';

const PLATFORM = 'platform-token';
const WALLET = 'wallet-token';

function storeWith(agentId: string, token: string): Store {
  const store = new Store(':memory:');
  store.setWalletTokenHash(agentId, hashToken(token));
  return store;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : `not-an-HttpError: ${String(err)}`;
  }
  return 'no-error';
}

describe('authenticate', () => {
  it('distinguishes the platform credential from a wallet one', () => {
    const store = storeWith('orch:persona', WALLET);
    expect(authenticate(`Bearer ${PLATFORM}`, PLATFORM, store)).toEqual({ scope: 'platform' });
    expect(authenticate(`Bearer ${WALLET}`, PLATFORM, store)).toEqual({ scope: 'wallet', agentId: 'orch:persona' });
    store.close();
  });

  it('refuses an unknown, empty or unschemed token', () => {
    const store = storeWith('orch:persona', WALLET);
    expect(codeOf(() => authenticate('Bearer nope', PLATFORM, store))).toBe('unauthorized');
    expect(codeOf(() => authenticate('Bearer ', PLATFORM, store))).toBe('unauthorized');
    expect(codeOf(() => authenticate(PLATFORM, PLATFORM, store))).toBe('unauthorized');
    expect(codeOf(() => authenticate(undefined, PLATFORM, store))).toBe('unauthorized');
    store.close();
  });

  // Rotation works by REPLACING the stored hash, so there is no list of
  // superseded tokens to forget to clean up - and the old credential stops
  // authenticating immediately.
  it('revokes the previous token when a new one is issued', () => {
    const store = storeWith('orch:persona', WALLET);
    expect(authenticate(`Bearer ${WALLET}`, PLATFORM, store)).toEqual({ scope: 'wallet', agentId: 'orch:persona' });

    store.setWalletTokenHash('orch:persona', hashToken('rotated-token'));

    expect(codeOf(() => authenticate(`Bearer ${WALLET}`, PLATFORM, store))).toBe('unauthorized');
    expect(authenticate('Bearer rotated-token', PLATFORM, store)).toEqual({
      scope: 'wallet',
      agentId: 'orch:persona',
    });
    store.close();
  });

  // The token is stored only as a hash, so a dumped database is not a set of
  // spending credentials.
  it('stores only a hash of the wallet token', () => {
    const store = storeWith('orch:persona', WALLET);
    expect(store.agentForTokenHash(hashToken(WALLET))).toBe('orch:persona');
    expect(store.agentForTokenHash(WALLET)).toBeNull();
    store.close();
  });

  it('compares without short-circuiting or throwing on length', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});

describe('the handler-level scope guard, isolated from the router', () => {
  it('refuses a wallet credential on a platform action', () => {
    expect(codeOf(() => requirePlatform({ scope: 'wallet', agentId: 'orch:a' }, 'POST /wallets'))).toBe('wrong_scope');
    expect(codeOf(() => requirePlatform({ scope: 'platform' }, 'POST /wallets'))).toBe('no-error');
  });

  it('derives the transfer source from the credential, not the body', () => {
    expect(walletPrincipal({ scope: 'wallet', agentId: 'orch:a' }, undefined)).toBe('orch:a');
    expect(walletPrincipal({ scope: 'wallet', agentId: 'orch:a' }, 'orch:a')).toBe('orch:a');
    // The drain, at the smallest scale it can be expressed.
    expect(codeOf(() => walletPrincipal({ scope: 'wallet', agentId: 'orch:a' }, 'orch:victim'))).toBe(
      'principal_mismatch',
    );
    expect(codeOf(() => walletPrincipal({ scope: 'platform' }, 'orch:a'))).toBe('wrong_scope');
  });

  it('restricts a wallet credential to reading its own wallet', () => {
    expect(codeOf(() => assertMayRead({ scope: 'wallet', agentId: 'orch:a' }, 'orch:a'))).toBe('no-error');
    expect(codeOf(() => assertMayRead({ scope: 'wallet', agentId: 'orch:a' }, 'orch:b'))).toBe('not_your_wallet');
    expect(codeOf(() => assertMayRead({ scope: 'wallet', agentId: 'orch:a' }, null))).toBe('not_your_wallet');
    // The platform credential reads anything, including an unnamed burner.
    expect(codeOf(() => assertMayRead({ scope: 'platform' }, 'orch:b'))).toBe('no-error');
    expect(codeOf(() => assertMayRead({ scope: 'platform' }, null))).toBe('no-error');
  });
});

// The router guard exists for the route somebody adds LATER without a
// requirePlatform call. Asserting the table is what isolates it: the
// end-to-end tests cannot, because the handler guard catches everything first.
// Isolates the ROUTER guard from the handler guard: a route whose handler does
// nothing, so only the router can refuse it. Without this, deleting the router
// check leaves every test passing, because each real platform handler also
// calls requirePlatform.
describe('the router-level scope guard, isolated from the handlers', () => {
  const unguarded = (scope: Route['scope']): Route => ({
    method: 'POST',
    path: '/hypothetical',
    prefix: false,
    scope,
    handler: async () => ({}),
  });

  it('refuses a wallet credential on a platform-scoped route', () => {
    expect(codeOf(() => assertRouteScope(unguarded('platform'), { scope: 'wallet', agentId: 'orch:a' }, 'x'))).toBe(
      'wrong_scope',
    );
    expect(codeOf(() => assertRouteScope(unguarded('platform'), { scope: 'platform' }, 'x'))).toBe('no-error');
  });

  it('refuses the platform credential on a wallet-scoped route', () => {
    expect(codeOf(() => assertRouteScope(unguarded('wallet'), { scope: 'platform' }, 'x'))).toBe('wrong_scope');
    expect(codeOf(() => assertRouteScope(unguarded('wallet'), { scope: 'wallet', agentId: 'orch:a' }, 'x'))).toBe(
      'no-error',
    );
  });

  it('lets either credential through an open route', () => {
    expect(codeOf(() => assertRouteScope(unguarded('any'), { scope: 'wallet', agentId: 'orch:a' }, 'x'))).toBe(
      'no-error',
    );
    expect(codeOf(() => assertRouteScope(unguarded('any'), { scope: 'platform' }, 'x'))).toBe('no-error');
  });
});

describe('the route table', () => {
  it('declares a scope for every route', () => {
    for (const route of ROUTES) {
      expect(['platform', 'wallet', 'any']).toContain(route.scope);
    }
  });

  it('never leaves a mutating route open to any credential', () => {
    const open = ROUTES.filter((r) => r.method !== 'GET' && r.scope === 'any');
    expect(open.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('keeps every wallet-mutating platform action off the wallet scope', () => {
    const platformOnly = ['/wallets', '/aliases', '/fund', '/stage'];
    for (const path of platformOnly) {
      const route = ROUTES.find((r) => r.path === path && r.method === 'POST');
      expect(route?.scope).toBe('platform');
    }
    expect(ROUTES.find((r) => r.method === 'DELETE')?.scope).toBe('platform');
  });
});

describe('policy enforcement', () => {
  const policy: AgentPolicy = { max_per_tx: 100, max_per_stage: 500, allow: ['*.vee'], deny: ['treasury.vee'] };
  const vee = (n: number) => BigInt(n) * 10n ** 18n;

  it('matches only the patterns the game config can express', () => {
    expect(matchesPattern('*', 'anything')).toBe(true);
    expect(matchesPattern('*.vee', 'alpha.vee')).toBe(true);
    expect(matchesPattern('*.vee', 'alpha.veex')).toBe(false);
    expect(matchesPattern('treasury.vee', 'treasury.vee')).toBe(true);
    expect(matchesPattern('treasury.vee', 'alpha.vee')).toBe(false);
  });

  it('refuses over max_per_tx and a denied counterparty', () => {
    expect(codeOf(() => enforcePolicy({ policy, to: 'alpha.vee', amount: vee(150) }))).toBe('over_max_per_tx');
    expect(codeOf(() => enforcePolicy({ policy, to: 'treasury.vee', amount: vee(1) }))).toBe('counterparty_denied');
    expect(codeOf(() => enforcePolicy({ policy, to: 'alpha.vee', amount: vee(100) }))).toBe('no-error');
  });

  // Deny wins: a name matching both lists is refused, because deny is what an
  // author writes to stop something specific.
  it('lets deny beat allow', () => {
    const both: AgentPolicy = { ...policy, allow: ['*'], deny: ['treasury.vee'] };
    expect(codeOf(() => enforcePolicy({ policy: both, to: 'treasury.vee', amount: vee(1) }))).toBe(
      'counterparty_denied',
    );
  });

  // The stage cap is NOT enforcePolicy's any more. It was, and that is exactly
  // why the cap did not hold: a predicate taking `spentThisStage` as an
  // argument can only test a figure somebody read earlier, and by the time the
  // money moved that figure was stale. These tests exercise the RESERVATION,
  // which is the thing that has to be right - and it is one primitive covering
  // the cap and the intent together, because they were the same defect twice:
  // a decision and its durable record that were not one operation.
  describe('the reservation', () => {
    const cap = stageCapWei(policy); // 500 VEE
    let n = 0;
    const uniq = () => `i${++n}`;
    const take = (store: Store, agentId: string, stage: string, amount: bigint, capWei: bigint) =>
      store.reserve({ intentId: uniq(), agentId, stage, amount, capWei });

    it('allows exactly up to the cap and no further', () => {
      const store = new Store(':memory:');
      expect(take(store, 'orch:a', 's1', vee(450), cap).outcome).toBe('reserved');
      expect(take(store, 'orch:a', 's1', vee(50), cap).outcome).toBe('reserved');
      expect(take(store, 'orch:a', 's1', vee(1), cap).outcome).toBe('over_stage_cap');
      expect(store.spentThisStage('orch:a', 's1')).toBe(vee(500));
      store.close();
    });

    // Both halves, because a refusal that still consumed the intent id would
    // make the caller's honest retry an unresolvable duplicate for ever.
    it('records NEITHER half when it refuses on the cap', () => {
      const store = new Store(':memory:');
      const id = 'refused-intent';
      expect(store.reserve({ intentId: id, agentId: 'orch:a', stage: 's1', amount: vee(600), capWei: cap }).outcome)
        .toBe('over_stage_cap');
      expect(store.spentThisStage('orch:a', 's1')).toBe(0n);
      // The id is still free: retrying under it after a top-up must work.
      expect(store.reserve({ intentId: id, agentId: 'orch:a', stage: 's1', amount: vee(1), capWei: cap }).outcome)
        .toBe('reserved');
      store.close();
    });

    it('keeps a separate budget per stage, so a stage change resets it', () => {
      const store = new Store(':memory:');
      expect(take(store, 'orch:a', 's1', vee(500), cap).outcome).toBe('reserved');
      expect(take(store, 'orch:a', 's1', vee(1), cap).outcome).toBe('over_stage_cap');
      expect(take(store, 'orch:a', 's2', vee(500), cap).outcome).toBe('reserved');
      store.close();
    });

    // THE STAGE-CAP REGRESSION. Three concurrent 100-VEE sends against a
    // 100/stage cap all succeeded, because read-check-write straddled four
    // awaits. Asserting the predicate cannot catch that - the old tests passed
    // `spentThisStage` in as a literal and proved only that the arithmetic was
    // right.
    it('admits exactly floor(cap/amount) of N concurrent reservations', () => {
      const store = new Store(':memory:');
      const results = Array.from({ length: 8 }, () => take(store, 'orch:racer', 's1', vee(100), vee(100)));
      expect(results.filter((r) => r.outcome === 'reserved')).toHaveLength(1); // floor(100/100)
      expect(store.spentThisStage('orch:racer', 's1')).toBe(vee(100));
      store.close();
    });

    it('admits exactly floor(cap/amount) when the cap is a multiple', () => {
      const store = new Store(':memory:');
      const results = Array.from({ length: 10 }, () => take(store, 'orch:racer', 's1', vee(100), vee(500)));
      expect(results.filter((r) => r.outcome === 'reserved')).toHaveLength(5); // floor(500/100)
      expect(store.spentThisStage('orch:racer', 's1')).toBe(vee(500));
      store.close();
    });

    // THE INTENT REGRESSION. chain-svc performed the transfer, the response was
    // dropped, and the caller's CORRECT retry transferred again - two real
    // transfers for one intent, the caller told it succeeded once.
    it('refuses a second reservation under the same intent id', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'once', agentId: 'orch:a', stage: 's1', amount: vee(10), capWei: cap };
      expect(store.reserve(args).outcome).toBe('reserved');
      expect(store.reserve(args).outcome).toBe('duplicate');
      // And it did not charge twice.
      expect(store.spentThisStage('orch:a', 's1')).toBe(vee(10));
      store.close();
    });

    it('answers a replayed intent with the ORIGINAL transaction hash', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'once', agentId: 'orch:a', stage: 's1', amount: vee(10), capWei: cap };
      store.reserve(args);
      store.completeIntent('once', '0xabc');
      expect(store.reserve(args)).toEqual({ outcome: 'duplicate', txHash: '0xabc' });
      store.close();
    });

    // The reconciliation case: reserved, broadcast, outcome unknown. It must be
    // distinguishable from a completed replay, because guessing either way is
    // wrong - re-sending double-charges, reporting success invents a hash.
    it('reports a reserved-but-uncompleted intent as duplicate with no hash', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'inflight', agentId: 'orch:a', stage: 's1', amount: vee(10), capWei: cap };
      store.reserve(args);
      expect(store.reserve(args)).toEqual({ outcome: 'duplicate', txHash: null });
      store.close();
    });

    it('admits exactly ONE of N concurrent reservations of the same intent', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'racy', agentId: 'orch:a', stage: 's1', amount: vee(1), capWei: cap };
      const results = Array.from({ length: 8 }, () => store.reserve(args));
      expect(results.filter((r) => r.outcome === 'reserved')).toHaveLength(1);
      expect(store.spentThisStage('orch:a', 's1')).toBe(vee(1));
      store.close();
    });

    // Release is for failures that PROVABLY precede the broadcast, and it gives
    // BOTH halves back - a released reservation that kept the intent id would
    // leave the caller unable to retry the send that never happened.
    it('release frees both the budget and the intent id', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'unsent', agentId: 'orch:a', stage: 's1', amount: vee(100), capWei: cap };
      store.reserve(args);
      store.release('unsent', 'orch:a', 's1', vee(100));
      expect(store.spentThisStage('orch:a', 's1')).toBe(0n);
      expect(store.reserve(args).outcome).toBe('reserved');
      store.close();
    });

    // The one thing release must NEVER do: undo a send that happened. Once a
    // hash is recorded the intent is history, not a reservation.
    it('release cannot erase a COMPLETED intent', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'done', agentId: 'orch:a', stage: 's1', amount: vee(100), capWei: cap };
      store.reserve(args);
      store.completeIntent('done', '0xabc');
      store.release('done', 'orch:a', 's1', vee(100));
      expect(store.reserve(args)).toEqual({ outcome: 'duplicate', txHash: '0xabc' });
      store.close();
    });

    // Both halves of `release` are gated on the SAME fact - did the DELETE
    // remove a row - because they were not, and the refund ran regardless.
    it('refunds nothing for an intent that was never reserved', () => {
      const store = new Store(':memory:');
      take(store, 'orch:a', 's1', vee(500), cap);
      store.release('never-existed', 'orch:a', 's1', vee(9999));
      // The budget stands. The old code refunded unconditionally and merely
      // CLAMPED at zero, which is a different property and the wrong one: it
      // made an unknown intent id a way to zero a wallet's stage spend.
      expect(store.spentThisStage('orch:a', 's1')).toBe(vee(500));
      store.close();
    });

    it('refunds once for a double release of the same intent', () => {
      const store = new Store(':memory:');
      const args = { intentId: 'twice', agentId: 'orch:a', stage: 's1', amount: vee(100), capWei: cap };
      store.reserve(args);
      store.release('twice', 'orch:a', 's1', vee(100));
      store.release('twice', 'orch:a', 's1', vee(100));
      expect(store.spentThisStage('orch:a', 's1')).toBe(0n);
      store.close();
    });

    // THE MEASURED DEFECT. reserve 100 under a 100 cap, complete it, release it:
    // the intent correctly survived as duplicate{txHash} while spentThisStage
    // dropped to 0, and a second 100-VEE send was then admitted.
    it('a release on a COMPLETED intent refunds nothing, so the cap still binds', () => {
      const store = new Store(':memory:');
      const capOf100 = vee(100);
      const args = { intentId: 'landed', agentId: 'orch:a', stage: 's1', amount: vee(100), capWei: capOf100 };
      expect(store.reserve(args).outcome).toBe('reserved');
      store.completeIntent('landed', '0xabc');

      store.release('landed', 'orch:a', 's1', vee(100));

      expect(store.reserve(args)).toEqual({ outcome: 'duplicate', txHash: '0xabc' });
      expect(store.spentThisStage('orch:a', 's1')).toBe(vee(100));
      expect(store.reserve({ ...args, intentId: 'second' }).outcome).toBe('over_stage_cap');
      store.close();
    });
  });
});
