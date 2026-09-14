#!/usr/bin/env python3
"""Mutation gate for the contracts.

Breaks each guard deliberately and requires the test that protects it to FAIL.
A guard that survives its mutant is inert: it describes the behaviour rather
than checking it.

WHY THIS SCRIPT IS COMMITTED AND NOT A THROWAWAY
------------------------------------------------
Three times in one evening the thing that was broken was the INSTRUMENT, not
the code under it:

  * an invariant that could not fail, because every handler action was guarded
    away from the case it was meant to catch;
  * this harness mis-parsing Foundry counterexamples (they contain ']', so
    splitting on the first one loses the test name) - every KILLED mutant read
    as a SURVIVOR;
  * a stage-cap test that funded a wallet with exactly its cap, so the refusal
    came back "insufficient balance" and the cap was never exercised.

Only the second was harmless, and only by luck of DIRECTION: it manufactured
work rather than silence. The same bug inverted - survivors reading as killed -
produces a clean sweep and reports "all mutants killed" having killed none.
The checks below exist to make the silent direction impossible.

  python3 contracts/mutation/run.py
"""

import hashlib
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
TEST_NAME = re.compile(r"((?:testFuzz_|test_|invariant_)\w+)")

# (id, file, description, anchor, replacement, the test that MUST fail)
MUTANTS = [
    ("M1", "src/NameRegistry.sol", "aliases may overwrite the canonical reverse",
     "        if (mayWriteReverse && reverse[target] == bytes32(0)) {",
     "        if (mayWriteReverse) {",
     "test_AliasDoesNotOverwriteCanonicalReverse"),
    ("M2", "src/NameRegistry.sol", "transfer no longer clears the stale reverse",
     "        if (reverse[rec.target] == key) {\n            delete reverse[rec.target];\n        }\n\n        emit Transferred",
     "\n        emit Transferred",
     "test_TransferClearsReverse"),
    ("M3", "src/NameRegistry.sol", "setTargetFor drops its existence check",
     "        bytes32 key = _requireExisting(name);\n        _setTarget(key, name, target);\n    }\n\n    /// @notice Address a name points at",
     "        bytes32 key = keccak256(bytes(name));\n        _setTarget(key, name, target);\n    }\n\n    /// @notice Address a name points at",
     "invariant_everyResolvableNameHasAnOwner"),
    ("M4", "src/NameRegistry.sol", "_setTarget adopts a reverse for the new target",
     "        if (reverse[previousTarget] == key) {\n            delete reverse[previousTarget];\n        }",
     "        if (reverse[previousTarget] == key) {\n            delete reverse[previousTarget];\n        }\n        if (target != address(0) && reverse[target] == bytes32(0)) {\n            reverse[target] = key;\n        }",
     "test_SetTargetClearsReverseAndDoesNotAdoptTheNewTarget"),
    ("M5", "src/NameRegistry.sol", "the charset rejects A-Z",
     "                || (c >= 0x41 && c <= 0x5a) // A-Z\n", "",
     "testFuzz_CharsetAcceptsExactlyTheAllowedBytes"),
    ("M6", "src/NameRegistry.sol", "duplicate registration is allowed",
     "        if (records[key].owner != address(0)) revert NameTaken();", "",
     "test_DuplicateRegistrationReverts"),
    ("M7", "src/NameRegistry.sol", "setTarget leaves a stale reverse behind",
     "        if (reverse[previousTarget] == key) {\n            delete reverse[previousTarget];\n        }",
     "        // mutant: stale reverse left behind",
     "invariant_reverseAlwaysResolvesBackToItsOwnAddress"),
    ("M8", "src/NameRegistry.sol", "the maximum-length bound is dropped",
     "        if (len > MAX_NAME_LENGTH) revert NameTooLong();", "",
     "testFuzz_LengthIsAcceptedExactlyWithinBounds"),
    # --- sec-reviewer-2's findings, and the guards added for them -----------
    ("M10", "src/NameRegistry.sol", "the permissionless register writes a primary name",
     "        _register(name, msg.sender, target, false);",
     "        _register(name, msg.sender, target, true);",
     "test_EvenTheRegistrarsRegisterDoesNotSetAPrimaryName"),
    ("M11", "src/NameRegistry.sol", "register makes the TARGET the owner",
     "        _register(name, msg.sender, target, false);",
     "        _register(name, target, target, false);",
     "test_RegisterMakesTheCallerTheOwnerEvenForAForeignTarget"),
    ("M12", "src/NameRegistry.sol", "registerFor accepts a zero owner or target",
     "        if (owner == address(0) || target == address(0)) revert ZeroAddress();", "",
     "test_RegisterForRejectsAZeroOwner"),
    ("M13", "src/NameRegistry.sol", "transfer to address(0) silently releases a name",
     "        if (newOwner == address(0)) revert ZeroAddress();", "",
     "test_TransferToZeroIsRefusedRatherThanSilentlyReleasing"),
    ("M14", "src/NameRegistry.sol", "a registry may deploy with no admin",
     "        if (admin == address(0)) revert ZeroAddress();\n        _grantRole(DEFAULT_ADMIN_ROLE, admin);\n        _grantRole(REGISTRAR_ROLE, admin);",
     "        _grantRole(DEFAULT_ADMIN_ROLE, admin);\n        _grantRole(REGISTRAR_ROLE, admin);",
     "test_RegistryDeployedWithNoAdminIsRefused"),
    ("M15", "src/NameRegistry.sol", "transfer clears the primary name unconditionally",
     "        if (reverse[rec.target] == key) {\n            delete reverse[rec.target];\n        }",
     "        delete reverse[rec.target];",
     "test_TransferringANonPrimaryNameNeverClearsThePrimary"),
    ("M16", "src/NameRegistry.sol", "the permissionless register accepts a zero target",
     "        if (target == address(0)) revert ZeroAddress();\n        _register(name, msg.sender, target, false);",
     "        _register(name, msg.sender, target, false);",
     "test_RegisterRejectsAZeroTarget"),
    ("M18", "src/NameRegistry.sol", "register is permissionless again (canonical-name squatting)",
     "    function register(string calldata name, address target) external onlyRole(REGISTRAR_ROLE) {",
     "    function register(string calldata name, address target) external {",
     "testFuzz_OnlyRegistrarCanRegister"),
    ("M19", "src/NameRegistry.sol", "register is permissionless - seen by the invariant handler",
     "    function register(string calldata name, address target) external onlyRole(REGISTRAR_ROLE) {",
     "    function register(string calldata name, address target) external {",
     "invariant_OnlyTheRegistrarCanTakeAName"),
    ("M17", "src/Token.sol", "the token may deploy with no admin (and so never mint)",
     "        if (admin == address(0)) revert ZeroAddress();\n        _grantRole(DEFAULT_ADMIN_ROLE, admin);", 
     "        _grantRole(DEFAULT_ADMIN_ROLE, admin);",
     "test_TokenDeployedWithNoAdminIsRefused"),
    ("M9", "src/Token.sol", "anyone may mint",
     "    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {",
     "    function mint(address to, uint256 amount) external {",
     "test_NonMinterCannotMint"),
    ("M20", "src/Token.sol", "anyone may burn anyone's balance",
     "    function burnFrom(address account, uint256 amount) external onlyRole(BURNER_ROLE) {",
     "    function burnFrom(address account, uint256 amount) external {",
     "test_BurnFromRevertsForACallerWithoutTheRole"),
    # --- Converter (§2 mutation gate) ---------------------------------------
    ("M21", "src/Converter.sol", "the loop guard is dropped, so a round trip may mint value",
     "            if (rate * reversePair.rate > RATE_SCALE * RATE_SCALE) {\n                revert LoopMintsValue(source, target, rate, reversePair.rate);\n            }\n",
     "",
     "test_LoopGuardRejectsAValueMintingRoundTrip"),
    ("M22", "src/Converter.sol", "the loop guard rejects a product of exactly 1 (> becomes >=)",
     "if (rate * reversePair.rate > RATE_SCALE * RATE_SCALE) {",
     "if (rate * reversePair.rate >= RATE_SCALE * RATE_SCALE) {",
     "test_LoopGuardAllowsExactlyProductOfOne"),
    ("M23", "src/Converter.sol", "convert mints before it burns (order swapped)",
     "        IMintBurnToken(source).burnFrom(msg.sender, amountIn);\n        IMintBurnToken(target).mint(msg.sender, amountOut);",
     "        IMintBurnToken(target).mint(msg.sender, amountOut);\n        IMintBurnToken(source).burnFrom(msg.sender, amountIn);",
     "test_ConvertBurnsBeforeItMints"),
    ("M24", "src/Converter.sol", "convert skips the pause check",
     "        if (p.paused) revert PairPaused(source, target);\n",
     "",
     "test_ConvertRevertsWhenPausedAndResumes"),
    ("M25", "src/Converter.sol", "quote rounds up instead of flooring",
     "        return amountIn * p.rate / RATE_SCALE;",
     "        return (amountIn * p.rate + RATE_SCALE - 1) / RATE_SCALE;",
     "test_QuoteFloorsAndMatchesTheWorkedExample"),
    ("M26", "src/Converter.sol", "convert drops the NothingMinted check",
     "        if (amountOut == 0) revert NothingMinted(amountIn, rate);\n",
     "",
     "test_ConvertRevertsWhenNothingMinted"),
]


def sha(path):
    with open(os.path.join(ROOT, path), "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()[:12]


def run_tests():
    proc = subprocess.run(["forge", "test"], cwd=ROOT, capture_output=True, text=True, timeout=1800)
    return proc.stdout + proc.stderr


def bare_forge_count(output):
    """What `forge test` itself reports, which is NOT what this script counts.

    Foundry prints one [PASS] per invariant FUNCTION but counts the whole
    invariant suite as ONE test. So this harness (which works in test names, to
    match a mutant against its target) sees more names than `forge test` sees
    tests. Both numbers are right; quoting one without saying which instrument
    produced it is what makes two people unable to reproduce each other.
    """
    match = re.search(r"(\d+) tests passed", output)
    return match.group(1) if match else "?"


def parse(output):
    """Returns (passed, failed, compiled).

    `compiled` matters: a mutation that breaks the build makes every test
    'fail', which would read as a kill for whichever test we were watching.
    That is a false pass, and it is the reason this returns three things
    instead of one.
    """
    compiled = "Compiler run failed" not in output and "Error: compilation" not in output.lower()
    passed, failed = set(), set()
    for line in output.splitlines():
        stripped = line.strip()
        match = TEST_NAME.search(stripped)
        if not match:
            continue
        if stripped.startswith("[PASS"):
            passed.add(match.group(1))
        elif stripped.startswith("[FAIL"):
            failed.add(match.group(1))
    return passed, failed, compiled


def main():
    print("=== baseline")
    output = run_tests()
    passed, failed, compiled = parse(output)
    if not compiled:
        sys.exit("ABORT: the tree does not compile before any mutation")
    if failed:
        sys.exit(f"ABORT: suite is not green before mutating: {sorted(failed)}")
    print(f"    {len(passed)} named tests pass (this harness, counting each invariant separately)")
    print(f"    {bare_forge_count(output)} tests pass per bare `forge test` (the invariant suite counts as one)")

    # A target that does not exist would make every mutant read as SURVIVED -
    # loud, but wasted. Catch the typo here rather than after nine forge runs.
    unknown = [m[0] + ":" + m[5] for m in MUTANTS if m[5] not in passed]
    if unknown:
        sys.exit(f"ABORT: these mutants name tests that did not run: {unknown}")

    results = []
    for mid, path, description, anchor, replacement, target in MUTANTS:
        full = os.path.join(ROOT, path)
        with open(full) as handle:
            before = handle.read()
        before_hash = sha(path)

        if anchor not in before:
            sys.exit(f"{mid}: ABORT - anchor not found in {path}; the mutation did not apply")
        after = before.replace(anchor, replacement, 1)
        if after == before:
            sys.exit(f"{mid}: ABORT - mutant is identical to the original")

        with open(full, "w") as handle:
            handle.write(after)
        after_hash = sha(path)

        _, mutant_failed, mutant_compiled = parse(run_tests())
        died = target in mutant_failed

        with open(full, "w") as handle:
            handle.write(before)
        assert sha(path) == before_hash, f"{mid}: restore failed"

        if not mutant_compiled:
            # Not a kill: the tests never ran. Reported separately so it can
            # never be counted as evidence the guard works.
            verdict = "INCONCLUSIVE (did not compile)"
            died = False
        else:
            verdict = "KILLED " if died else "SURVIVED"

        print(f"{mid} {verdict} [{before_hash}->{after_hash}] {description}")
        # Printed for kills too, not only survivors: a kill accompanied by
        # unrelated failures may be the mutation hitting something other than
        # what it was aimed at.
        print(f"     target: {target}")
        print(f"     failed under the mutant: {sorted(mutant_failed) if mutant_failed else 'NONE'}")
        results.append(died)

    print("\n=== restored")
    _, failed_after, _ = parse(run_tests())
    print(f"    failing: {sorted(failed_after) if failed_after else 'none'}")

    ok = all(results) and not failed_after
    print("\nALL MUTANTS KILLED" if ok else "\nPROBLEM: see above")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
