// Does this store still belong to this chain? (spec S4)
//
// §4 says the store and the chain state share ONE LIFETIME, and the pair can
// come apart in two directions. #52 detects one of them: the store wiped beside
// a live chain, which frees every consumed intent id and releases every freeze.
// This is the other: THE CHAIN REPLACED WHILE THE STORE SURVIVES.
//
// What that costs is worse than it sounds, because there is no repair path.
// `spawn` short-circuits on the store's own marker - `spawn.ts` reads
// `spawnedAddress` and returns before `keystore.has` is ever consulted - so a
// re-spawn never re-registers the name on the new registry. `DELETE /wallets`
// retires rather than deletes and keeps the id, so re-creating returns the
// retired wallet. Every wallet that had a key becomes permanently unresolvable,
// and the arena's seat is a scenario that cannot spin up at all.
//
// AND THE SYMPTOM POINTS AT THE ONE COMPONENT THAT IS FINE. The caller sees
// `unknown_name`, which sends the reader to the registry - which is behaving
// correctly, on a chain that is behaving correctly, with a store that is
// behaving correctly. Only the PAIRING is wrong. That cost three full rebuilds
// before anyone looked at the lifetime rather than at the name.
//
// WHY IDENTITY AND NOT NAMES. The obvious detection - a spawn marker whose
// canonical name is not registered - is the STEADY STATE OF A BURNER: a burner
// registers no names by design (`spawn.ts`, `if (kind !== 'burner')`) while
// `markSpawned` runs for every kind, and the store has no kind column to tell
// them apart. So that check reddens on a healthy game. This asks the only
// question that actually matters - ARE THESE THE SAME TWO ARTEFACTS THEY WERE -
// which has no burner case, no retirement case, and no per-wallet reasoning at
// all. It also catches a chain SWAP rather than only a wipe, which a name check
// could never have reached.

export interface DeploymentIdentity {
  chainId: string;
  veeBux: string;
  nameRegistry: string;
}

export class ChainSwapError extends Error {
  readonly code = 'chain_replaced_under_store';
  constructor(message: string) {
    super(message);
    this.name = 'ChainSwapError';
  }
}

const show = (id: DeploymentIdentity) =>
  `chain ${id.chainId}, VEEBux ${id.veeBux}, NameRegistry ${id.nameRegistry}`;

/// Compares what the store remembers against what booted.
///
/// `recorded` null means a store that has never seen a deployment: the caller
/// records the live one and starts.
///
/// ⚠ THAT NULL BRANCH IS AN UNGUARDED ESCAPE HATCH, AND IT IS EASIER THAN THE
/// ONE WE GUARDED. `DELETE FROM deployment` - one row, not the store - reaches
/// a clean start with NO refusal, NO warning and no record that anything was
/// overridden, while the acknowledgement flag deliberately warns on every boot
/// so the state stays visible. The loud path is the harder one. Measured:
///
///     boot against a different deployment   -> refused, naming both
///     DELETE FROM deployment; boot again    -> starts clean, silent
///
/// IT CANNOT BE CLOSED TODAY, and the reason is not squeamishness. "Spawn
/// markers present ∧ no deployment row" is EXACTLY a legitimate v2→v3 store:
/// the table is created empty by the migration while the markers survive.
/// Measured, both states are identical - `recorded = null`, markers present -
/// so any discriminator written now would refuse a correct upgrade, which is
/// the burner mistake in a different costume.
///
/// ⚠ AND THE LIMITATION WILL EXPIRE SILENTLY, WHICH IS THE PART WORTH WRITING
/// DOWN. The two stop being indistinguishable once no v2 store remains -
/// after that, a missing row can only mean a fresh store or a wiped one, and a
/// fresh store has no spawn markers. NOTHING WILL ANNOUNCE THAT MOMENT. A
/// limitation that will quietly become closeable is worse than a permanent one,
/// because the person who could close it has no signal that the time came.
///
/// So the condition is named rather than left implicit: THIS IS CLOSEABLE ONCE
/// NO v2 STORES REMAIN. An earlier closure is possible if the migration ever
/// records that it upgraded a store from v2 - then "no row ∧ upgraded-from-v2"
/// is legitimate and "no row ∧ born at v3" is a wipe - but that is a second
/// table to keep honest and is deliberately NOT built here.
export function assertDeploymentUnchanged(
  recorded: DeploymentIdentity | null,
  live: DeploymentIdentity,
  acknowledged: boolean,
): void {
  if (recorded === null) return;
  const same =
    recorded.chainId === live.chainId &&
    recorded.veeBux.toLowerCase() === live.veeBux.toLowerCase() &&
    recorded.nameRegistry.toLowerCase() === live.nameRegistry.toLowerCase();
  if (same) return;

  // ACKNOWLEDGED PERMITS THIS BOOT AND NOTHING MORE. The recorded identity is
  // deliberately NOT updated: the disagreement is real and unresolved until
  // repair exists, so quieting it would be a detector reporting "fixed" when
  // nothing is fixed - the wallets are still unregistered and the operator will
  // still meet `unknown_name` at runtime. A flag that silences a true alarm is
  // worse than no flag; one that says "I know, start anyway" every boot is
  // merely annoying, and the annoyance is proportionate to the state.
  if (acknowledged) {
    console.warn(
      `[chain-svc] chain_replaced_under_store ACKNOWLEDGED: this store was written ` +
        `against ${show(recorded)} and is now pointed at ${show(live)}. Starting anyway. ` +
        `THIS IS NOT FIXED - wallets spawned against the old chain are still not ` +
        `registered on the new one and will answer unknown_name. This warning repeats ` +
        `every boot until the disagreement is resolved.`,
    );
    return;
  }

  throw new ChainSwapError(
    `refusing to start: THE CHAIN AND THE STORE DISAGREE. This store was written ` +
      `against ${show(recorded)}; the chain that just booted is ${show(live)}.\n` +
      `\n` +
      `The store is fine, the chain is fine, and the registry is fine - only the ` +
      `PAIRING is wrong, which is why the symptom is "unknown_name" and points at the ` +
      `one component behaving correctly. Every wallet spawned against the old chain ` +
      `has a spawn marker here and no name on the new registry, so a re-spawn returns ` +
      `the existing wallet without re-registering it and the name never comes back.\n` +
      `\n` +
      `The store and the chain state share one lifetime (spec S4): destroy both or ` +
      `neither. If you meant to replace the chain, replace the store with it. To start ` +
      `once against this chain anyway - which does NOT repair the names - use ` +
      `--acknowledge-chain-reset (or CHAIN_SVC_ACKNOWLEDGE_CHAIN_RESET=1).`,
  );
}
