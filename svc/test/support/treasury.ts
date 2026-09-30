// The half of Chain that sends as the treasury, for a test's fake chain.
//
// Production code can no longer reach a chain's wallet client - it is private,
// and `sendAsTreasury` is the only door - so a fake chain supplies that door
// instead of a `walletClient` field. Given a real TreasuryLock it sends under
// it, which is how the concurrency test exercises the production lock rather
// than a copy of it; without one it simply hands the wallet over.
import type { TreasuryLock } from '../../src/chain.ts';

export function treasurySender(wallet: unknown, lock?: TreasuryLock) {
  return {
    sendAsTreasury: (fn: (w: never) => Promise<unknown>) =>
      lock ? lock.run(() => fn(wallet as never)) : fn(wallet as never),
  };
}
