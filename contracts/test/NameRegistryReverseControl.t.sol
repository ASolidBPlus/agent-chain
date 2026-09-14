// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {NameRegistry} from "../src/NameRegistry.sol";

/// @title Who controls an address's primary name (ruled, spec S3.2).
/// @notice A primary name is the canonical id the REGISTRAR set, or nothing.
/// `register` is forward-only: it makes names resolve and never touches
/// `reverse`. Before that rule, a stranger could set the primary name of any
/// address that had none - permanently, for burner wallets, which by design
/// never receive a registerFor and exist precisely to be traced.
///
/// One test per claim, deliberately: a single scenario that trips several
/// guards at once proves none of them.
contract NameRegistryReverseControlTest is Test {
    NameRegistry internal registry;

    address internal treasury = makeAddr("treasury");
    address internal victim = makeAddr("victim");
    address internal attacker = makeAddr("attacker");

    string internal constant CANONICAL = "orch:victim";

    function setUp() public {
        registry = new NameRegistry(treasury);
    }

    /// The outer gate (ruled): a stranger cannot take a name at all.
    /// This is the one that closes canonical-name squatting, because a name is
    /// a unique resource and a canonical id is derivable before its agent
    /// exists - so "forward-only" alone still let an attacker own `orch:victim`
    /// and have every payment to that name resolve to them.
    function test_AStrangerCannotRegisterAtAll() public {
        vm.prank(attacker);
        vm.expectRevert();
        registry.register("attacker.vee", victim);

        assertEq(registry.resolve("attacker.vee"), address(0), "a stranger took a name");
    }

    /// The inner gate, independently: even the REGISTRAR's `register` is
    /// forward-only. Kept separate from the gate above so each is isolated -
    /// with only the modifier tested, removing the forward-only rule would
    /// leave every test here green.
    function test_EvenTheRegistrarsRegisterDoesNotSetAPrimaryName() public {
        vm.prank(treasury);
        registry.register("label.vee", victim);

        assertEq(registry.resolve("label.vee"), victim, "the forward mapping should still work");
        assertEq(registry.reverseOf(victim), "", "register wrote a primary name");
    }

    /// A burner never receives a registerFor, so this is its permanent state -
    /// and the reason the finding matters even though no funds move.
    function test_AnAddressThatNeverGetsACanonicalNameKeepsNoPrimaryName() public {
        vm.prank(treasury);
        registry.register("burner-label.vee", victim);
        vm.prank(treasury);
        registry.register("another-label.vee", victim);

        assertEq(registry.reverseOf(victim), "", "an unnamed address acquired a primary name");
    }

    /// The regression that matters: a failed squat on a canonical id must
    /// leave the name free, so the agent can still be spawned. Before the
    /// modifier this reverted NameTaken at spawn, permanently, and no repoint
    /// could recover it - the attacker owned the name and could always move it
    /// back, and `transfer` reverts NotOwner.
    function test_AFailedSquatLeavesTheCanonicalNameFreeToSpawn() public {
        vm.prank(attacker);
        vm.expectRevert();
        registry.register(CANONICAL, attacker);

        vm.prank(treasury);
        registry.registerFor(CANONICAL, victim, victim);

        assertEq(registry.resolve(CANONICAL), victim, "a payment to the canonical name would not reach the victim");
        assertEq(registry.reverseOf(victim), CANONICAL);
    }

    /// And it cannot displace one that already exists.
    function test_ALaterForwardOnlyNameChangesNothing() public {
        vm.prank(treasury);
        registry.registerFor(CANONICAL, victim, victim);

        vm.prank(treasury);
        registry.register("label.vee", victim);

        assertEq(registry.reverseOf(victim), CANONICAL);
    }

    /// Transferring a name that is NOT the primary must leave the primary
    /// alone. The clearing rule is "only if reverse holds THIS name", and a
    /// version that cleared unconditionally would pass every other test here.
    function test_TransferringANonPrimaryNameNeverClearsThePrimary() public {
        vm.prank(treasury);
        registry.registerFor(CANONICAL, victim, victim);
        vm.prank(treasury);
        registry.registerFor("victim.vee", victim, victim); // an alias, not the primary

        vm.prank(victim);
        registry.transfer("victim.vee", attacker);

        assertEq(registry.reverseOf(victim), CANONICAL, "transferring an alias cleared the primary name");
    }

    /// The mirror: transferring the primary DOES clear it, so the two halves of
    /// the rule are pinned separately rather than by one scenario.
    function test_TransferringThePrimaryNameDoesClearIt() public {
        vm.prank(treasury);
        registry.registerFor(CANONICAL, victim, victim);

        vm.prank(victim);
        registry.transfer(CANONICAL, attacker);

        assertEq(registry.reverseOf(victim), "", "the primary survived its own transfer");
    }
}
