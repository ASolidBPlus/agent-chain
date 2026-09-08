// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {NameRegistry} from "../src/NameRegistry.sol";

contract NameRegistryTest is Test {
    NameRegistry internal registry;
    bytes32 internal registrarRole;

    address internal treasury = makeAddr("treasury");
    address internal shadowbroker = makeAddr("shadowbroker");
    address internal darknetclient = makeAddr("darknetclient");
    address internal scammer = makeAddr("scammer");

    string internal constant CANONICAL = "orch:shadowbroker";
    string internal constant ALIAS = "shadowbroker.vee";

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

    /// The permissionless path is FORWARD-ONLY (ruled 22:12 UTC): it makes a
    /// name resolve and never writes a primary name, even when the caller
    /// registers for itself. A primary name is the registrar's canonical id or
    /// nothing - which is what stops a stranger claiming the primary of an
    /// address that has none, burners included.
    function test_RegisterResolveRoundTrip() public {
        vm.prank(treasury);
        registry.register(CANONICAL, shadowbroker);

        assertEq(registry.resolve(CANONICAL), shadowbroker);
        assertEq(registry.reverseOf(shadowbroker), "", "register must not write a primary name");
    }

    /// The registrar's path is the one that does.
    function test_RegisterForSetsThePrimaryName() public {
        vm.prank(treasury);
        registry.registerFor(CANONICAL, shadowbroker, shadowbroker);

        assertEq(registry.resolve(CANONICAL), shadowbroker);
        assertEq(registry.reverseOf(shadowbroker), CANONICAL);
    }

    function test_RegistrarCanRegisterForOthers() public {
        _spawn(CANONICAL, shadowbroker);

        (address owner, address target) = registry.records(keccak256(bytes(CANONICAL)));
        assertEq(owner, shadowbroker);
        assertEq(target, shadowbroker);
        assertEq(registry.resolve(CANONICAL), shadowbroker);
    }

    function test_NonRegistrarCannotRegisterForOthers() public {
        vm.prank(scammer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, scammer, registrarRole
            )
        );
        registry.registerFor(CANONICAL, shadowbroker, shadowbroker);
    }

    function test_DuplicateRegistrationReverts() public {
        _spawn(CANONICAL, shadowbroker);

        vm.prank(treasury);
        vm.expectRevert(NameRegistry.NameTaken.selector);
        registry.register(CANONICAL, scammer);

        // The original registration is untouched - a failed land-grab must not
        // repoint the name it failed to take.
        assertEq(registry.resolve(CANONICAL), shadowbroker);
    }

    /// Views return a miss as a VALUE, never a revert (ruled 19:15 UTC):
    /// chain-svc turns address(0) into its 404 and cannot decode a revert.
    function test_ResolveUnknownNameReturnsZeroAddress() public view {
        assertEq(registry.resolve("nobody.vee"), address(0));
    }

    function test_ReverseOfUnknownAddressReturnsEmptyString() public view {
        assertEq(registry.reverseOf(darknetclient), "");
    }

    // --- the reverse record ------------------------------------------------

    /// The rule that keeps money legible: a wallet's primary name is its
    /// canonical mesh id, and buying vanity aliases never changes it.
    function test_AliasDoesNotOverwriteCanonicalReverse() public {
        _spawn(CANONICAL, shadowbroker);

        vm.prank(treasury);
        registry.registerFor(ALIAS, shadowbroker, shadowbroker);

        assertEq(registry.reverseOf(shadowbroker), CANONICAL);
        // Both names still resolve to the same wallet.
        assertEq(registry.resolve(ALIAS), shadowbroker);
        assertEq(registry.resolve(CANONICAL), shadowbroker);
    }

    function test_TransferClearsReverse() public {
        _spawn(CANONICAL, shadowbroker);
        assertEq(registry.reverseOf(shadowbroker), CANONICAL);

        vm.prank(shadowbroker);
        registry.transfer(CANONICAL, darknetclient);

        (address owner,) = registry.records(keccak256(bytes(CANONICAL)));
        assertEq(owner, darknetclient);
        // The name no longer speaks for the address it still targets.
        assertEq(registry.reverseOf(shadowbroker), "");
    }

    function test_NonOwnerTransferReverts() public {
        _spawn(CANONICAL, shadowbroker);

        vm.prank(scammer);
        vm.expectRevert(NameRegistry.NotOwner.selector);
        registry.transfer(CANONICAL, scammer);

        (address owner,) = registry.records(keccak256(bytes(CANONICAL)));
        assertEq(owner, shadowbroker);
    }

    function test_SetTargetClearsReverseAndDoesNotAdoptTheNewTarget() public {
        _spawn(CANONICAL, shadowbroker);

        vm.prank(shadowbroker);
        registry.setTarget(CANONICAL, darknetclient);

        assertEq(registry.resolve(CANONICAL), darknetclient);
        // Cleared for the address it left.
        assertEq(registry.reverseOf(shadowbroker), "");
        // NOT adopted by the address it moved to: the reverse is written on
        // register only, so repointing a name cannot promote it to be
        // somebody's primary name behind their back.
        assertEq(registry.reverseOf(darknetclient), "");
    }

    function test_NonOwnerCannotSetTarget() public {
        _spawn(CANONICAL, shadowbroker);

        vm.prank(scammer);
        vm.expectRevert(NameRegistry.NotOwner.selector);
        registry.setTarget(CANONICAL, scammer);

        assertEq(registry.resolve(CANONICAL), shadowbroker);
    }

    // --- retirement (the DELETE /wallets path) -----------------------------

    /// Retiring an agent clears its ALIAS targets with the registrar key, and
    /// must not need the agent's own key (spec S4, ruled 19:15 UTC).
    function test_RegistrarCanClearAliasTargetWithoutOwnerKey() public {
        _spawn(CANONICAL, shadowbroker);
        vm.prank(treasury);
        registry.registerFor(ALIAS, shadowbroker, shadowbroker);

        vm.prank(treasury);
        registry.setTargetFor(ALIAS, address(0));

        // The alias stops resolving - chain-svc turns this into its 404.
        assertEq(registry.resolve(ALIAS), address(0));
        // The canonical name is untouched: retirement clears aliases, and the
        // wallet keeps its identity for history and audit.
        assertEq(registry.reverseOf(shadowbroker), CANONICAL);
        assertEq(registry.resolve(CANONICAL), shadowbroker);
    }

    function test_NonRegistrarCannotSetTargetFor() public {
        _spawn(CANONICAL, shadowbroker);

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
        registry.setTargetFor("nobody.vee", scammer);

        assertEq(registry.resolve("nobody.vee"), address(0));
    }

    function test_TransferOfUnknownNameReverts() public {
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.UnknownName.selector);
        registry.transfer("nobody.vee", scammer);
    }

    // --- names as given ----------------------------------------------------

    /// Phishing-by-name is a game mechanic (spec S3.2): `aIpha.vee` (capital i)
    /// and `alpha.vee` (lowercase L) are two different, equally valid names and
    /// the registry must not normalise them together. If this test ever fails
    /// because the charset rejected the capital, the mechanic is gone.
    function test_LookalikeNamesCoexist() public {
        _spawn("alpha:darknetclient", darknetclient);
        vm.prank(treasury);
        registry.registerFor("alpha.vee", darknetclient, darknetclient);

        _spawn("orch:scammer", scammer);
        vm.prank(treasury);
        registry.registerFor("aIpha.vee", scammer, scammer);

        assertEq(registry.resolve("alpha.vee"), darknetclient);
        assertEq(registry.resolve("aIpha.vee"), scammer);
        assertTrue(registry.resolve("alpha.vee") != registry.resolve("aIpha.vee"));
    }

    function test_NameTooShortReverts() public {
        vm.prank(treasury);
        vm.expectRevert(NameRegistry.NameTooShort.selector);
        registry.registerFor("ab", shadowbroker, shadowbroker);
    }

    function test_NameTooLongReverts() public {
        // 49 characters: one past the on-chain cap that chain-svc's 3-48 bound
        // on qualified ids exists to stay inside.
        string memory tooLong = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assertEq(bytes(tooLong).length, 49);

        vm.prank(treasury);
        vm.expectRevert(NameRegistry.NameTooLong.selector);
        registry.registerFor(tooLong, shadowbroker, shadowbroker);
    }

    function test_MaximumLengthNameIsAccepted() public {
        string memory atCap = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assertEq(bytes(atCap).length, 48);

        vm.prank(treasury);
        registry.registerFor(atCap, shadowbroker, shadowbroker);
        assertEq(registry.resolve(atCap), shadowbroker);
    }

    function test_InvalidCharacterReverts() public {
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.InvalidNameChar.selector, 4, bytes1("!")));
        registry.registerFor("orch!shadowbroker", shadowbroker, shadowbroker);
    }

    /// A space is the one an operator types by accident, and it must not become
    /// a name that looks identical to a legitimate one in a log line.
    function test_SpaceIsRejected() public {
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(NameRegistry.InvalidNameChar.selector, 5, bytes1(" ")));
        registry.registerFor("alpha .vee", shadowbroker, shadowbroker);
    }
}
