// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {NameRegistry} from "../src/NameRegistry.sol";

contract NameRegistryTest is Test {
    NameRegistry internal registry;
    bytes32 internal registrarRole;

    address internal treasury = makeAddr("treasury");
    address internal vendor = makeAddr("vendor");
    address internal client = makeAddr("client");
    address internal scammer = makeAddr("scammer");

    string internal constant CANONICAL = "orch:vendor";
    string internal constant ALIAS = "vendor.play";

    function setUp() public {
        registry = new NameRegistry(treasury);
        // Cached: reading a public constant is an external call, which would
        // consume a pending vm.prank if read inside a pranked statement.
        registrarRole = registry.REGISTRAR_ROLE();
    }

    /// Register a canonical id the way chain-svc does at spawn.
    function _spawn(string memory name, address wallet) internal {
        vm.prank(treasury);
        registry.registerFor(name, wallet, wallet);
    }

    // --- registration and lookup -------------------------------------------

    /// The permissionless path is FORWARD-ONLY (ruled): it makes a
    /// name resolve and never writes a primary name, even when the caller
    /// registers for itself. A primary name is the registrar's canonical id or
    /// nothing - which is what stops a stranger claiming the primary of an
    /// address that has none, burners included.
    function test_RegisterResolveRoundTrip() public {
        vm.prank(treasury);
        registry.register(CANONICAL, vendor);

        assertEq(registry.resolve(CANONICAL), vendor);
        assertEq(registry.reverseOf(vendor), "", "register must not write a primary name");
    }

    /// The registrar's path is the one that does.
    function test_RegisterForSetsThePrimaryName() public {
        vm.prank(treasury);
        registry.registerFor(CANONICAL, vendor, vendor);

        assertEq(registry.resolve(CANONICAL), vendor);
        assertEq(registry.reverseOf(vendor), CANONICAL);
    }

    function test_RegistrarCanRegisterForOthers() public {
        _spawn(CANONICAL, vendor);

        (address owner, address target) = registry.records(keccak256(bytes(CANONICAL)));
        assertEq(owner, vendor);
        assertEq(target, vendor);
        assertEq(registry.resolve(CANONICAL), vendor);
    }

    function test_NonRegistrarCannotRegisterForOthers() public {
        vm.prank(scammer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, scammer, registrarRole
            )
        );
        registry.registerFor(CANONICAL, vendor, vendor);
    }

    function test_DuplicateRegistrationReverts() public {
        _spawn(CANONICAL, vendor);

        vm.prank(treasury);
        vm.expectRevert(NameRegistry.NameTaken.selector);
        registry.register(CANONICAL, scammer);

        // The original registration is untouched - a failed land-grab must not
        // repoint the name it failed to take.
        assertEq(registry.resolve(CANONICAL), vendor);
    }

    /// Views return a miss as a VALUE, never a revert (ruled):
    /// chain-svc turns address(0) into its 404 and cannot decode a revert.
    function test_ResolveUnknownNameReturnsZeroAddress() public view {
        assertEq(registry.resolve("nobody.play"), address(0));
    }

    function test_ReverseOfUnknownAddressReturnsEmptyString() public view {
        assertEq(registry.reverseOf(client), "");
    }

    // --- the reverse record ------------------------------------------------

    /// The rule that keeps money legible: a wallet's primary name is its
    /// canonical mesh id, and buying vanity aliases never changes it.
    function test_AliasDoesNotOverwriteCanonicalReverse() public {
        _spawn(CANONICAL, vendor);

        vm.prank(treasury);
        registry.registerFor(ALIAS, vendor, vendor);

        assertEq(registry.reverseOf(vendor), CANONICAL);
        // Both names still resolve to the same wallet.
        assertEq(registry.resolve(ALIAS), vendor);
        assertEq(registry.resolve(CANONICAL), vendor);
    }

    function test_TransferClearsReverse() public {
        _spawn(CANONICAL, vendor);
        assertEq(registry.reverseOf(vendor), CANONICAL);

        vm.prank(vendor);
        registry.transfer(CANONICAL, client);

        (address owner,) = registry.records(keccak256(bytes(CANONICAL)));
        assertEq(owner, client);
        // The name no longer speaks for the address it still targets.
        assertEq(registry.reverseOf(vendor), "");
    }

    function test_NonOwnerTransferReverts() public {
        _spawn(CANONICAL, vendor);

        vm.prank(scammer);
        vm.expectRevert(NameRegistry.NotOwner.selector);
        registry.transfer(CANONICAL, scammer);

        (address owner,) = registry.records(keccak256(bytes(CANONICAL)));
        assertEq(owner, vendor);
    }

    function test_SetTargetClearsReverseAndDoesNotAdoptTheNewTarget() public {
        _spawn(CANONICAL, vendor);

        vm.prank(vendor);
        registry.setTarget(CANONICAL, client);

        assertEq(registry.resolve(CANONICAL), client);
        // Cleared for the address it left.
        assertEq(registry.reverseOf(vendor), "");
        // NOT adopted by the address it moved to: the reverse is written on
        // register only, so repointing a name cannot promote it to be
        // somebody's primary name behind their back.
        assertEq(registry.reverseOf(client), "");
    }

    function test_NonOwnerCannotSetTarget() public {
        _spawn(CANONICAL, vendor);

        vm.prank(scammer);
        vm.expectRevert(NameRegistry.NotOwner.selector);
        registry.setTarget(CANONICAL, scammer);

        assertEq(registry.resolve(CANONICAL), vendor);
    }

    // --- retirement (the DELETE /wallets path) -----------------------------

    /// Retiring an agent clears its ALIAS targets with the registrar key, and
    /// must not need the agent's own key (spec S4, ruled).
    function test_RegistrarCanClearAliasTargetWithoutOwnerKey() public {
        _spawn(CANONICAL, vendor);
        vm.prank(treasury);
        registry.registerFor(ALIAS, vendor, vendor);

        vm.prank(treasury);
        registry.setTargetFor(ALIAS, address(0));

        // The alias stops resolving - chain-svc turns this into its 404.
        assertEq(registry.resolve(ALIAS), address(0));
        // The canonical name is untouched: retirement clears aliases, and the
        // wallet keeps its identity for history and audit.
        assertEq(registry.reverseOf(vendor), CANONICAL);
        assertEq(registry.resolve(CANONICAL), vendor);
    }

    function test_NonRegistrarCannotSetTargetFor() public {
        _spawn(CANONICAL, vendor);

        vm.prank(scammer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, scammer, registrarRole
            )
        );
        registry.setTargetFor(CANONICAL, scammer);
    }

    /// setTargetFor has no owner check by design, so without an existence check
    /// it would write a target for a name nobody registered - a phantom record
    /// owned by address(0) that resolve() would then serve.
    function test_SetTargetForUnknownNameReverts() public {
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.UnknownName.selector);
        registry.setTargetFor("nobody.play", scammer);

        assertEq(registry.resolve("nobody.play"), address(0));
    }

    function test_TransferOfUnknownNameReverts() public {
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.UnknownName.selector);
        registry.transfer("nobody.play", scammer);
    }

    // --- names as given ----------------------------------------------------

    /// Phishing-by-name is a game mechanic (spec S3.2): `aIpha.play` (capital i)
    /// and `alpha.play` (lowercase L) are two different, equally valid names and
    /// the registry must not normalise them together. If this test ever fails
    /// because the charset rejected the capital, the mechanic is gone.
    ///
    /// ⚠ THE TWO NAMES MUST STAY VISUALLY CONFUSABLE AND BYTE-DISTINCT. That is
    /// the whole property, and it is the one a later rename can destroy while
    /// leaving every assertion green: make them merely different (`alpha` and
    /// `bravo`) and this test passes forever without testing the mechanic at
    /// all. Do not "tidy" the capital I into an l, and do not replace the pair
    /// with two unrelated names.
    ///
    /// The assertions below are deliberately stronger than "the addresses
    /// differ": they pin that the NAMES differ as bytes and that BOTH resolve,
    /// so a rename that collapsed them into one string fails here rather than
    /// passing on a comparison of a name with itself.
    function test_LookalikeNamesCoexist() public {
        assertTrue(
            keccak256(bytes("alpha.play")) != keccak256(bytes("aIpha.play")),
            "the lookalike pair has stopped being two different names"
        );

        _spawn("alpha:client", client);
        vm.prank(treasury);
        registry.registerFor("alpha.play", client, client);

        _spawn("orch:scammer", scammer);
        vm.prank(treasury);
        registry.registerFor("aIpha.play", scammer, scammer);

        assertEq(registry.resolve("alpha.play"), client);
        assertEq(registry.resolve("aIpha.play"), scammer);
        assertTrue(registry.resolve("alpha.play") != address(0), "alpha.play must resolve");
        assertTrue(registry.resolve("aIpha.play") != address(0), "aIpha.play must resolve");
        assertTrue(registry.resolve("alpha.play") != registry.resolve("aIpha.play"));
    }

    function test_NameTooShortReverts() public {
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.NameTooShort.selector);
        registry.registerFor("ab", vendor, vendor);
    }

    function test_NameTooLongReverts() public {
        // 49 characters: one past the on-chain cap that chain-svc's 3-48 bound
        // on qualified ids exists to stay inside.
        string memory tooLong = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assertEq(bytes(tooLong).length, 49);

        vm.prank(treasury);
        vm.expectRevert(NameRegistry.NameTooLong.selector);
        registry.registerFor(tooLong, vendor, vendor);
    }

    function test_MaximumLengthNameIsAccepted() public {
        string memory atCap = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assertEq(bytes(atCap).length, 48);

        vm.prank(treasury);
        registry.registerFor(atCap, vendor, vendor);
        assertEq(registry.resolve(atCap), vendor);
    }

    function test_InvalidCharacterReverts() public {
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.InvalidNameChar.selector, 4, bytes1("!")));
        registry.registerFor("orch!vendor", vendor, vendor);
    }

    /// A space is the one an operator types by accident, and it must not become
    /// a name that looks identical to a legitimate one in a log line.
    function test_SpaceIsRejected() public {
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.InvalidNameChar.selector, 5, bytes1(" ")));
        registry.registerFor("alpha .play", vendor, vendor);
    }
}
