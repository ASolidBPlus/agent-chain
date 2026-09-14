// The dedupe ledger and local spend record.
//
// A JSON file with atomic replace, NOT sqlite (ruled): this package
// is imported by org-core as a library, so it must carry no native dependency
// and run under bun or node unchanged. The state is small - a map of intent ids
// to results - and a whole-file rewrite is cheaper than a dependency.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface IntentResult {
  txHash: string;
  vee: string;
  to: string;
  at: number;
}

interface StoreShape {
  version: 1;
  /// intent_id -> the result of the send it authorised. Only ACCEPTED sends are
  /// recorded: a refusal must be retryable, and a refused send counts zero
  /// toward any total (spec S5's accounting rule).
  intents: Record<string, IntentResult>;
}

const EMPTY: StoreShape = { version: 1, intents: {} };

export class WalletStore {
  private state: StoreShape;

  constructor(private readonly path: string) {
    this.state = this.read();
  }

  private read(): StoreShape {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreShape;
      if (parsed?.version === 1 && typeof parsed.intents === 'object' && parsed.intents !== null) return parsed;
    } catch {
      // Missing or unreadable: start empty. A corrupt ledger must not stop the
      // agent spending, and starting empty is safe - but NOT for the reason
      // this comment used to give.
      //
      // It said the authority for double-spend prevention is the chain. That
      // was never true: the token is a plain ERC-20, and a second identical
      // transfer is a valid second transfer, not a rejected replay. Nothing
      // downstream was ever going to catch a duplicate, so this file losing
      // its memory was a double-charge waiting for a dropped response.
      //
      // The authority is chain-svc's RESERVATION: the intent id is taken under
      // a primary key BEFORE the transfer is broadcast, so a replay is answered
      // with the original transaction rather than sent again. THAT is what
      // makes this file a convenience that saves a round trip. If that
      // reservation ever goes away, this comment is a lie again and the
      // starting-empty behaviour above becomes a defect.
    }
    return structuredClone(EMPTY);
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    // Temp-then-rename: a reader (or a restart) must never see a half-written
    // ledger, which would parse as "no intents recorded" and permit a replay.
    writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(temp, this.path);
  }

  /// AN INTENT IS NEVER REMOVED FROM THIS LEDGER. There is deliberately no
  /// delete, expire or prune, and adding one would be a double-charge.
  ///
  /// The same invariant chain-svc's intents table holds, one layer up: THE
  /// IDEMPOTENCY KEY'S LIFETIME IS THE GAME'S, REGARDLESS OF OUTCOME. A
  /// persona re-sending under an id it has used before must meet the ORIGINAL
  /// OUTCOME, and an entry that can disappear is one that stops answering.
  ///
  /// chain-svc's reservation is the authority and would refuse the replay even
  /// if this file were empty - but "the other layer would catch it" is how both
  /// layers end up trusting each other and neither holding the line. This one
  /// is what makes the replay free rather than a round trip.
  ///
  /// A failed send records nothing here today, which is correct: nothing was
  /// resolved, so there is no outcome to replay, and chain-svc answers the
  /// retry. If a terminal FAILED outcome is ever recorded, it must be recorded
  /// and kept - a tombstone - never written and later removed.
  recall(intentId: string): IntentResult | null {
    return this.state.intents[intentId] ?? null;
  }

  remember(intentId: string, result: IntentResult): void {
    this.state.intents[intentId] = result;
    this.write();
  }
}
