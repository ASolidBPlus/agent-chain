// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Token} from "../src/Token.sol";

contract TokenTest is Test {
    Token internal play;
    /// Cached in setUp on purpose: `play.MINTER_ROLE()` is an external call, so
    /// reading it inside a pranked statement consumes the prank and the call
    /// under test runs as the test contract instead. Cost two failing tests.
    bytes32 internal minterRole;
    bytes32 internal burnerRole;

    address internal treasury = makeAddr("treasury");
    address internal vendor = makeAddr("vendor");
    address internal client = makeAddr("client");

    function setUp() public {
        play = new Token("Play Token", "PLAY", treasury);
        minterRole = play.MINTER_ROLE();
        burnerRole = play.BURNER_ROLE();
    }

    /// The metadata is now WHATEVER THE CONSTRUCTOR WAS GIVEN, which is the
    /// whole point of the generic contract: this asserts the arguments came
    /// through, not that the token is called anything in particular.
    function test_MetadataIsWhateverTheConstructorWasGiven() public {
        assertEq(play.name(), "Play Token");
        assertEq(play.symbol(), "PLAY");
        assertEq(play.decimals(), 18);

        Token other = new Token("Gold Pieces", "GOLD", treasury);
        assertEq(other.name(), "Gold Pieces");
        assertEq(other.symbol(), "GOLD");
        assertEq(other.decimals(), 18);
    }

    // ── BURNER_ROLE: a role nobody holds ────────────────────────────────────
    //
    // The contract ships with a burn path and no burner. These three cases pin
    // that: unreachable by default, reachable once granted, and the grant is
    // what changes - not the deploy.

    function test_NobodyHoldsBurnerRoleAtDeploy() public view {
        assertFalse(play.hasRole(burnerRole, treasury));
        assertFalse(play.hasRole(burnerRole, address(this)));
        assertFalse(play.hasRole(burnerRole, vendor));
    }

    function test_BurnFromRevertsForACallerWithoutTheRole() public {
        vm.prank(treasury);
        play.mint(vendor, 100 ether);

        vm.prank(vendor);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, vendor, burnerRole)
        );
        play.burnFrom(vendor, 1 ether);
    }

    function test_BurnFromReducesSupplyAndBalanceOnceGranted() public {
        vm.prank(treasury);
        play.mint(vendor, 100 ether);
        vm.prank(treasury);
        play.grantRole(burnerRole, client);

        vm.prank(client);
        play.burnFrom(vendor, 40 ether);

        assertEq(play.balanceOf(vendor), 60 ether);
        assertEq(play.totalSupply(), 60 ether);
    }

    function test_TreasuryCanMint() public {
        vm.prank(treasury);
        play.mint(vendor, 250 ether);

        assertEq(play.balanceOf(vendor), 250 ether);
        assertEq(play.totalSupply(), 250 ether);
    }

    /// Minting is the whole money supply of the game. If any wallet could call
    /// it, every policy cap in wallet-mcp is decorative.
    function test_NonMinterCannotMint() public {
        vm.prank(vendor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, vendor, minterRole
            )
        );
        play.mint(vendor, 1 ether);

        assertEq(play.totalSupply(), 0);
    }

    function test_TransferMovesBalance() public {
        vm.prank(treasury);
        play.mint(vendor, 100 ether);

        vm.prank(vendor);
        play.transfer(client, 40 ether);

        assertEq(play.balanceOf(vendor), 60 ether);
        assertEq(play.balanceOf(client), 40 ether);
    }

    /// The admin can hand MINTER_ROLE to the facilitator API for mid-game
    /// top-ups (spec S3.1) without redeploying the token.
    function test_AdminCanGrantMinterRole() public {
        vm.prank(treasury);
        play.grantRole(minterRole, vendor);

        vm.prank(vendor);
        play.mint(client, 5 ether);

        assertEq(play.balanceOf(client), 5 ether);
    }

    // ---- transferWithIntent -------------------------------------------------

    event IntentTransfer(bytes32 indexed intentId, address indexed from, address indexed to, uint256 amount);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function _fund(address who, uint256 amount) internal {
        vm.prank(treasury);
        play.mint(who, amount);
    }

    function test_TransferWithIntentMovesTheMoneyAndEmitsBothEvents() public {
        _fund(vendor, 100e18);
        bytes32 intent = keccak256(bytes("orch:vendor:pay-1"));

        // ALONGSIDE, not instead of: anything reading Transfer is unaffected.
        vm.expectEmit(true, true, false, true);
        emit Transfer(vendor, client, 40e18);
        vm.expectEmit(true, true, true, true);
        emit IntentTransfer(intent, vendor, client, 40e18);

        vm.prank(vendor);
        play.transferWithIntent(client, 40e18, intent);

        assertEq(play.balanceOf(client), 40e18);
        assertEq(play.balanceOf(vendor), 60e18);
    }

    /// The mover is msg.sender and there is no `from` parameter, so this cannot
    /// be used to move someone else's balance even with an allowance in place.
    function test_TransferWithIntentCannotSpendSomeoneElsesBalance() public {
        _fund(vendor, 100e18);
        vm.prank(vendor);
        play.approve(client, 100e18);

        // client holds an allowance over vendor, and it buys
        // nothing here: it can only move its own (zero) balance.
        vm.prank(client);
        vm.expectRevert();
        play.transferWithIntent(treasury, 1e18, keccak256(bytes("theft")));

        assertEq(play.balanceOf(vendor), 100e18);
    }

    /// THE DESIGN, asserted so nobody "hardens" it into a uniqueness constraint
    /// without deleting this test first. Two sends under one intent id BOTH
    /// succeed and BOTH emit - the event proves a transfer happened, never that
    /// it happened once. That is what makes a second event detectable as an
    /// anomaly instead of silently reverting.
    function test_TheContractDoesNotDeduplicateIntents() public {
        _fund(vendor, 100e18);
        bytes32 intent = keccak256(bytes("reused"));

        vm.prank(vendor);
        play.transferWithIntent(client, 10e18, intent);
        vm.prank(vendor);
        play.transferWithIntent(client, 10e18, intent);

        assertEq(play.balanceOf(client), 20e18);
    }

    function test_TransferWithIntentRespectsBalance() public {
        _fund(vendor, 5e18);
        vm.prank(vendor);
        vm.expectRevert();
        play.transferWithIntent(client, 6e18, keccak256(bytes("too-much")));
    }

    /// The id is opaque to the contract: a zero id is a caller error, not a
    /// contract concern, and refusing it here would add a rule chain-svc would
    /// then have to mirror.
    function testFuzz_AnyIntentIdIsCarriedThrough(bytes32 intent) public {
        _fund(vendor, 10e18);
        vm.expectEmit(true, true, true, true);
        emit IntentTransfer(intent, vendor, client, 1e18);
        vm.prank(vendor);
        play.transferWithIntent(client, 1e18, intent);
    }
}
