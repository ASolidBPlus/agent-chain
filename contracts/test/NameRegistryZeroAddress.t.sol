// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {NameRegistry} from "../src/NameRegistry.sol";
import {Token} from "../src/Token.sol";

/// @title The zero-address sentinel paths (sec-reviewer-2, finding 2).
/// @notice address(0) is not a neutral value in this contract: a record whose
/// OWNER is zero reads as unregistered to every check here while still holding
/// `reverse[target]`, and a transfer to zero is therefore a silent RELEASE
/// rather than a burn. Each test below states which of those it is guarding.
contract NameRegistryZeroAddressTest is Test {
    NameRegistry internal registry;

    address internal treasury = makeAddr("treasury");
    address internal wallet = makeAddr("wallet");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        registry = new NameRegistry(treasury);
    }

    // --- registration --------------------------------------------------

    function test_RegisterForRejectsAZeroOwner() public {
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.ZeroAddress.selector);
        registry.registerFor("ghost.play", address(0), wallet);
    }

    function test_RegisterForRejectsAZeroTarget() public {
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.ZeroAddress.selector);
        registry.registerFor("ghost.play", wallet, address(0));
    }

    function test_RegisterRejectsAZeroTarget() public {
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.ZeroAddress.selector);
        registry.register("ghost.play", address(0));
    }

    /// The recovery path, which is the part that makes the zero-owner case a
    /// security bug rather than an oddity: a zero-owner record would leave the
    /// name re-registerable by anyone WHILE `reverseOf(target)` still pointed
    /// at it, so an attacker takes the name and inherits the victim's primary.
    function test_ARejectedZeroOwnerLeavesNoRecordAndNoReverse() public {
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.ZeroAddress.selector);
        registry.registerFor("ghost.play", address(0), wallet);

        // Nothing was captured on the way to the revert.
        assertEq(registry.resolve("ghost.play"), address(0), "a rejected registration left a record");
        assertEq(registry.reverseOf(wallet), "", "a rejected registration captured the target's primary name");

        // And the name is genuinely free afterwards, to its rightful owner.
        vm.prank(treasury);
        registry.registerFor("ghost.play", wallet, wallet);
        assertEq(registry.resolve("ghost.play"), wallet);
        assertEq(registry.reverseOf(wallet), "ghost.play");
    }

    // --- transfer ------------------------------------------------------

    /// Not a burn: the record survives, resolve() keeps answering, and every
    /// ownership check reads the name as unregistered - so the next caller can
    /// re-register a name that is still resolving to somebody's wallet.
    function test_TransferToZeroIsRefusedRatherThanSilentlyReleasing() public {
        vm.prank(treasury);
        registry.registerFor("alpha.play", wallet, wallet);

        vm.prank(wallet);
        vm.expectRevert(NameRegistry.ZeroAddress.selector);
        registry.transfer("alpha.play", address(0));

        (address owner,) = registry.records(keccak256(bytes("alpha.play")));
        assertEq(owner, wallet, "ownership moved despite the revert");
    }

    function test_AReleasedNameCannotBeReclaimed() public {
        vm.prank(treasury);
        registry.registerFor("alpha.play", wallet, wallet);

        vm.prank(wallet);
        vm.expectRevert(NameRegistry.ZeroAddress.selector);
        registry.transfer("alpha.play", address(0));

        // The name is still taken, so even the registrar cannot re-take it.
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.NameTaken.selector);
        registry.register("alpha.play", attacker);
    }

    // --- deployment ----------------------------------------------------

    /// Non-blocking finding, fixed in the same pass: a registry with no
    /// registrar, or a token that can never mint, is unrecoverable - there is
    /// no admin left to grant the role, so the only fix is redeploying, which
    /// after balances exist means abandoning them.
    ///
    /// ONE DEPLOYMENT PER TEST, deliberately. The first version asserted both
    /// in a single test with two vm.expectRevert calls, and the Token guard's
    /// mutant SURVIVED it: the second expectation was not enforced, so removing
    /// the token's zero-admin check changed nothing the suite could see, while
    /// forge coverage reported that branch as 0/1 and was right. Two guards in
    /// one scenario test neither - the same rule that has caught four other
    /// things in this suite.
    function test_RegistryDeployedWithNoAdminIsRefused() public {
        vm.expectRevert(NameRegistry.ZeroAddress.selector);
        new NameRegistry(address(0));
    }

    function test_TokenDeployedWithNoAdminIsRefused() public {
        vm.expectRevert(Token.ZeroAddress.selector);
        new Token("x", "X", address(0));
    }

    // --- the permissionless path with a foreign target -----------------

    /// Driven here for the first time: every earlier `register` call passed
    /// `target == msg.sender`, so the caller-becomes-owner rule was never
    /// actually tested against a target that differs. The mutant
    /// `_register(name, target, target)` survives a suite that never varies it.
    function test_RegisterMakesTheCallerTheOwnerEvenForAForeignTarget() public {
        vm.prank(treasury);
        registry.register("pointer.play", wallet);

        (address owner, address target) = registry.records(keccak256(bytes("pointer.play")));
        assertEq(owner, treasury, "the caller must be the owner, not the target");
        assertEq(target, wallet);
        assertEq(registry.resolve("pointer.play"), wallet);
        // Forward-only: see NameRegistryReverseControlTest for the full rule.
        assertEq(registry.reverseOf(wallet), "", "the permissionless path wrote a primary name");
    }
}
