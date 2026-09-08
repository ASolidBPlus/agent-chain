// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {VEEBux} from "../src/VEEBux.sol";

contract VEEBuxTest is Test {
    VEEBux internal vee;
    /// Cached in setUp on purpose: `vee.MINTER_ROLE()` is an external call, so
    /// reading it inside a pranked statement consumes the prank and the call
    /// under test runs as the test contract instead. Cost two failing tests.
    bytes32 internal minterRole;

    address internal treasury = makeAddr("treasury");
    address internal shadowbroker = makeAddr("shadowbroker");
    address internal darknetclient = makeAddr("darknetclient");

    function setUp() public {
        vee = new VEEBux(treasury);
        minterRole = vee.MINTER_ROLE();
    }

    function test_MetadataIsVEEBux() public view {
        assertEq(vee.name(), "VEE Bux");
        assertEq(vee.symbol(), "VEE");
        assertEq(vee.decimals(), 18);
    }

    function test_TreasuryCanMint() public {
        vm.prank(treasury);
        vee.mint(shadowbroker, 250 ether);

        assertEq(vee.balanceOf(shadowbroker), 250 ether);
        assertEq(vee.totalSupply(), 250 ether);
    }

    /// Minting is the whole money supply of the game. If any wallet could call
    /// it, every policy cap in wallet-mcp is decorative.
    function test_NonMinterCannotMint() public {
        vm.prank(shadowbroker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, shadowbroker, minterRole
            )
        );
        vee.mint(shadowbroker, 1 ether);

        assertEq(vee.totalSupply(), 0);
    }

    function test_TransferMovesBalance() public {
        vm.prank(treasury);
        vee.mint(shadowbroker, 100 ether);

        vm.prank(shadowbroker);
        vee.transfer(darknetclient, 40 ether);

        assertEq(vee.balanceOf(shadowbroker), 60 ether);
        assertEq(vee.balanceOf(darknetclient), 40 ether);
    }

    /// The admin can hand MINTER_ROLE to the facilitator API for mid-game
    /// top-ups (spec S3.1) without redeploying the token.
    function test_AdminCanGrantMinterRole() public {
        vm.prank(treasury);
        vee.grantRole(minterRole, shadowbroker);

        vm.prank(shadowbroker);
        vee.mint(darknetclient, 5 ether);

        assertEq(vee.balanceOf(darknetclient), 5 ether);
    }
}
