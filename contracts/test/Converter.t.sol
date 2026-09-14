// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Token} from "../src/Token.sol";
import {Converter, IMintBurnToken} from "../src/Converter.sol";

/// A minimal IMintBurnToken that records the global order of burn/mint calls
/// across both token instances, so a test can prove convert burns before it
/// mints. End-state cannot prove order: convert is atomic, so a swapped order
/// reverts or succeeds identically. Only an observer between the two calls sees
/// it, which is what this shared recorder is.
contract OrderRecorder {
    string[] public log;

    function record(string calldata what) external {
        log.push(what);
    }

    function len() external view returns (uint256) {
        return log.length;
    }

    function at(uint256 i) external view returns (string memory) {
        return log[i];
    }
}

contract CallOrderToken is IMintBurnToken {
    OrderRecorder internal rec;

    constructor(OrderRecorder rec_) {
        rec = rec_;
    }

    function mint(address, uint256) external override {
        rec.record("mint");
    }

    function burnFrom(address, uint256) external override {
        rec.record("burn");
    }
}

contract ConverterTest is Test {
    Converter internal conv;
    Token internal play;
    Token internal gold;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    // External calls, so cache in setUp: reading them inside a prank consumes it.
    bytes32 internal rateAdminRole;
    bytes32 internal minterRole;
    bytes32 internal burnerRole;

    event PairSet(
        address indexed source, address indexed target, uint256 rate, uint256 previousRate, address indexed by
    );
    event PairPausedSet(address indexed source, address indexed target, bool paused, address indexed by);
    event Converted(
        address indexed account,
        address indexed source,
        address indexed target,
        uint256 amountIn,
        uint256 amountOut,
        uint256 rate,
        bytes32 intentId
    );

    function setUp() public {
        play = new Token("Play", "PLAY", admin);
        gold = new Token("Gold", "GOLD", admin);
        conv = new Converter(admin);

        rateAdminRole = conv.RATE_ADMIN_ROLE();
        minterRole = play.MINTER_ROLE();
        burnerRole = play.BURNER_ROLE();

        // §1.4: the Converter is an additional minter and the sole burner on
        // both tokens, for both directions used by these tests. The admin
        // (treasury) keeps MINTER_ROLE on each token; it never holds BURNER_ROLE.
        vm.startPrank(admin);
        play.grantRole(burnerRole, address(conv));
        play.grantRole(minterRole, address(conv));
        gold.grantRole(burnerRole, address(conv));
        gold.grantRole(minterRole, address(conv));
        vm.stopPrank();
    }

    function _fund(Token token, address who, uint256 amount) internal {
        vm.prank(admin);
        token.mint(who, amount);
    }

    function _setPair(address source, address target, uint256 rate) internal {
        vm.prank(admin);
        conv.setPair(source, target, rate);
    }

    // ---- construction -------------------------------------------------------

    function test_ConstructorRejectsZeroAdmin() public {
        vm.expectRevert(Converter.ZeroAddress.selector);
        new Converter(address(0));
    }

    function test_ConstructorGrantsAdminBothRoles() public view {
        assertTrue(conv.hasRole(conv.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(conv.hasRole(rateAdminRole, admin));
    }

    // ---- setPair: access and validation (§2.1) ------------------------------

    function test_SetPairByNonAdminReverts() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, rateAdminRole)
        );
        conv.setPair(address(play), address(gold), 1e18);
    }

    function test_SetPairSameTokenReverts() public {
        vm.prank(admin);
        vm.expectRevert(Converter.SameToken.selector);
        conv.setPair(address(play), address(play), 1e18);
    }

    function test_SetPairZeroRateReverts() public {
        vm.prank(admin);
        vm.expectRevert(Converter.ZeroRate.selector);
        conv.setPair(address(play), address(gold), 0);
    }

    function test_SetPairZeroAddressReverts() public {
        vm.startPrank(admin);
        vm.expectRevert(Converter.ZeroAddress.selector);
        conv.setPair(address(0), address(gold), 1e18);
        vm.expectRevert(Converter.ZeroAddress.selector);
        conv.setPair(address(play), address(0), 1e18);
        vm.stopPrank();
    }

    function test_SetPairRejectsRateAboveMaxAndAcceptsMax() public {
        uint256 max = conv.MAX_RATE();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Converter.RateTooHigh.selector, max + 1));
        conv.setPair(address(play), address(gold), max + 1);

        _setPair(address(play), address(gold), max);
        (uint256 rate,, bool exists) = conv.pair(address(play), address(gold));
        assertEq(rate, max);
        assertTrue(exists);
    }

    // ---- setPair: create / update semantics (§2.2) --------------------------

    function test_SetPairCreateEmitsPreviousZeroAndUnpaused() public {
        vm.expectEmit(true, true, true, true);
        emit PairSet(address(play), address(gold), 3e18, 0, admin);
        _setPair(address(play), address(gold), 3e18);

        (uint256 rate, bool paused, bool exists) = conv.pair(address(play), address(gold));
        assertEq(rate, 3e18);
        assertFalse(paused);
        assertTrue(exists);
    }

    function test_SetPairUpdateEmitsPreviousRateAndKeepsPaused() public {
        _setPair(address(play), address(gold), 3e18);

        // Pause, then update: the pause flag must survive the rate change.
        vm.prank(admin);
        conv.setPaused(address(play), address(gold), true);

        vm.expectEmit(true, true, true, true);
        emit PairSet(address(play), address(gold), 5e18, 3e18, admin);
        _setPair(address(play), address(gold), 5e18);

        (uint256 rate, bool paused,) = conv.pair(address(play), address(gold));
        assertEq(rate, 5e18);
        assertTrue(paused, "update cleared the pause flag");
    }

    // ---- loop guard (§2.3) --------------------------------------------------

    function test_LoopGuardRejectsAValueMintingRoundTrip() public {
        _setPair(address(play), address(gold), 0.75e18);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                Converter.LoopMintsValue.selector, address(gold), address(play), 1.5e18, 0.75e18
            )
        );
        conv.setPair(address(gold), address(play), 1.5e18); // 0.75 * 1.5 = 1.125 > 1
    }

    function test_LoopGuardAllowsProductAtMostOneThenCatchesAnUpdate() public {
        _setPair(address(play), address(gold), 0.75e18);
        _setPair(address(gold), address(play), 1e18); // 0.75 * 1 = 0.75 <= 1, ok

        // Updating play->gold to 2 now loops: 2 * 1 = 2 > 1.
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Converter.LoopMintsValue.selector, address(play), address(gold), 2e18, 1e18)
        );
        conv.setPair(address(play), address(gold), 2e18);
    }

    function test_LoopGuardAllowsExactlyProductOfOne() public {
        _setPair(address(play), address(gold), 1e18);
        _setPair(address(gold), address(play), 1e18); // product == 1e36, allowed (not > )
        (uint256 rate,, bool exists) = conv.pair(address(gold), address(play));
        assertEq(rate, 1e18);
        assertTrue(exists);
    }

    // ---- quote (§2.4) -------------------------------------------------------

    function test_QuoteFloorsAndMatchesTheWorkedExample() public {
        _setPair(address(play), address(gold), 0.75e18);
        // 40.000001 at 0.75 = 30.00000075, exact in 18-place units.
        assertEq(conv.quote(address(play), address(gold), 40_000_001e12), 30_000_000_750_000_000_000);
        // A sub-unit remainder is floored, not rounded: 3 * 0.75 = 2.25 -> 2.
        assertEq(conv.quote(address(play), address(gold), 3), 2);
    }

    function test_QuoteUnknownPairReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Converter.UnknownPair.selector, address(play), address(gold)));
        conv.quote(address(play), address(gold), 1e18);
    }

    function test_QuoteIgnoresPause() public {
        _setPair(address(play), address(gold), 2e18);
        vm.prank(admin);
        conv.setPaused(address(play), address(gold), true);
        assertEq(conv.quote(address(play), address(gold), 5e18), 10e18);
    }

    // ---- setPaused (§1.3) ---------------------------------------------------

    function test_SetPausedUnknownPairReverts() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Converter.UnknownPair.selector, address(play), address(gold)));
        conv.setPaused(address(play), address(gold), true);
    }

    function test_SetPausedEmits() public {
        _setPair(address(play), address(gold), 1e18);
        vm.expectEmit(true, true, true, true);
        emit PairPausedSet(address(play), address(gold), true, admin);
        vm.prank(admin);
        conv.setPaused(address(play), address(gold), true);
    }

    // ---- convert (§2.5) -----------------------------------------------------

    function test_ConvertHappyPath() public {
        _setPair(address(play), address(gold), 0.75e18);
        _fund(play, alice, 100e18);
        bytes32 intent = keccak256(bytes("intent-1"));

        vm.expectEmit(true, true, true, true);
        emit Converted(alice, address(play), address(gold), 40e18, 30e18, 0.75e18, intent);

        vm.prank(alice);
        uint256 out = conv.convert(address(play), address(gold), 40e18, intent);

        assertEq(out, 30e18);
        assertEq(play.balanceOf(alice), 60e18);
        assertEq(gold.balanceOf(alice), 30e18);
        assertEq(play.totalSupply(), 60e18, "source supply down by amountIn");
        assertEq(gold.totalSupply(), 30e18, "target supply up by amountOut");
    }

    function test_ConvertZeroAmountReverts() public {
        _setPair(address(play), address(gold), 1e18);
        _fund(play, alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(Converter.ZeroAmount.selector);
        conv.convert(address(play), address(gold), 0, bytes32(0));
    }

    function test_ConvertUnknownPairReverts() public {
        _fund(play, alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Converter.UnknownPair.selector, address(play), address(gold)));
        conv.convert(address(play), address(gold), 1e18, bytes32(0));
    }

    function test_ConvertRevertsWhenPausedAndResumes() public {
        _setPair(address(play), address(gold), 1e18);
        _fund(play, alice, 10e18);

        vm.prank(admin);
        conv.setPaused(address(play), address(gold), true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Converter.PairPaused.selector, address(play), address(gold)));
        conv.convert(address(play), address(gold), 1e18, bytes32(0));

        vm.prank(admin);
        conv.setPaused(address(play), address(gold), false);

        vm.prank(alice);
        conv.convert(address(play), address(gold), 1e18, bytes32(0));
        assertEq(gold.balanceOf(alice), 1e18);
    }

    function test_ConvertRevertsWhenNothingMinted() public {
        _setPair(address(play), address(gold), 0.75e18);
        _fund(play, alice, 10e18);
        // 1 wei * 0.75 = 0.75 -> floors to 0.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Converter.NothingMinted.selector, 1, 0.75e18));
        conv.convert(address(play), address(gold), 1, bytes32(0));
        assertEq(play.balanceOf(alice), 10e18, "nothing burned when nothing would be minted");
    }

    // ---- convert: grants and atomicity (§2.6, §2.7) -------------------------

    function test_ConvertWithoutBurnerRoleRevertsAndMintsNothing() public {
        _setPair(address(play), address(gold), 0.75e18);
        _fund(play, alice, 100e18);

        vm.prank(admin);
        play.revokeRole(burnerRole, address(conv));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(conv), burnerRole
            )
        );
        conv.convert(address(play), address(gold), 40e18, bytes32(0));

        assertEq(gold.totalSupply(), 0, "nothing minted");
        assertEq(play.balanceOf(alice), 100e18, "nothing burned");
    }

    function test_ConvertWithoutMinterRoleRollsBackTheBurn() public {
        _setPair(address(play), address(gold), 0.75e18);
        _fund(play, alice, 100e18);

        vm.prank(admin);
        gold.revokeRole(minterRole, address(conv));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(conv), minterRole
            )
        );
        conv.convert(address(play), address(gold), 40e18, bytes32(0));

        assertEq(play.balanceOf(alice), 100e18, "burn rolled back with the failed mint");
        assertEq(play.totalSupply(), 100e18);
        assertEq(gold.totalSupply(), 0);
    }

    function test_ConvertInsufficientBalanceRevertsInsideToken() public {
        _setPair(address(play), address(gold), 1e18);
        _fund(play, alice, 5e18);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 5e18, 6e18)
        );
        conv.convert(address(play), address(gold), 6e18, bytes32(0));
        assertEq(gold.totalSupply(), 0, "nothing minted");
    }

    // ---- no allowances (§2.8) ----------------------------------------------

    function test_ConvertCannotTouchAnotherAccountsBalance() public {
        _setPair(address(play), address(gold), 1e18);
        _fund(play, bob, 100e18);

        // alice holds nothing; convert acts on msg.sender only, so it cannot
        // reach bob's balance even though bob is funded.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, 10e18)
        );
        conv.convert(address(play), address(gold), 10e18, bytes32(0));

        assertEq(play.balanceOf(bob), 100e18, "bob's balance untouched");
    }

    // ---- round trip (§2.9) --------------------------------------------------

    function test_RoundTripBurnsTheSpread() public {
        _setPair(address(play), address(gold), 0.75e18);
        _setPair(address(gold), address(play), 1e18);
        _fund(play, alice, 100e18);

        vm.startPrank(alice);
        uint256 goldOut = conv.convert(address(play), address(gold), 100e18, bytes32(0)); // 75 gold
        uint256 playBack = conv.convert(address(gold), address(play), goldOut, bytes32(0)); // 75 play
        vm.stopPrank();

        assertEq(goldOut, 75e18);
        assertEq(playBack, 75e18);
        assertEq(play.balanceOf(alice), 75e18, "left with 75 of the 100 put in");
        assertEq(gold.balanceOf(alice), 0);
        // The 25 are gone from supply, not parked anywhere.
        assertEq(play.totalSupply(), 75e18);
        assertEq(gold.totalSupply(), 0);
    }

    // ---- burn-then-mint order (kills the swap mutant) -----------------------

    function test_ConvertBurnsBeforeItMints() public {
        OrderRecorder rec = new OrderRecorder();
        CallOrderToken src = new CallOrderToken(rec);
        CallOrderToken dst = new CallOrderToken(rec);
        Converter c = new Converter(admin);

        vm.prank(admin);
        c.setPair(address(src), address(dst), 1e18);

        vm.prank(alice);
        c.convert(address(src), address(dst), 1e18, bytes32(0));

        assertEq(rec.len(), 2);
        assertEq(rec.at(0), "burn", "source must be burned first");
        assertEq(rec.at(1), "mint", "target minted only after the burn");
    }
}
