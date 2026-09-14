// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";
import {Converter} from "../src/Converter.sol";

/// Drives the Converter through random sequences of the operations chain-svc
/// performs. Every action is GUARDED so it cannot revert (fail_on_revert = true),
/// EXCEPT the two try/catch actions whose whole point is that the contract must
/// refuse them — a success there is the finding, counted rather than swallowed.
contract ConverterHandler is Test {
    Converter public conv;
    Token public play;
    Token public gold;
    address public treasury;

    address[] public actors;

    /// Every faucet mint, summed. The only sanctioned way new supply enters.
    uint256 public faucetTotal;

    /// Upper bound per (account, token): everything the faucet gave it plus
    /// everything a conversion minted to it. A balance above this would be value
    /// from nowhere.
    mapping(address => mapping(address => uint256)) public entitlement;

    /// Must stay zero: the loop guard must reject any reverse rate whose product
    /// with the forward rate exceeds 1 (RATE_SCALE^2). Counted so a dropped guard
    /// is visible here, not only in the unit tests.
    uint256 public loopMintingPairAccepted;

    /// Must stay zero: a completed A->B->A round trip must never return more than
    /// it put in. This is what the loop guard buys, checked through actual
    /// conversions rather than by inspecting rates.
    uint256 public roundTripMintedValue;

    /// Running Σ(amountOut − amountIn) across EVERY convert (both single
    /// conversions and both legs of a round trip). Signed: burns exceed mints
    /// when a rate is below 1. Underpins the supply identity (I4).
    int256 public convertNetDelta;

    constructor(Converter conv_, Token play_, Token gold_, address treasury_) {
        conv = conv_;
        play = play_;
        gold = gold_;
        treasury = treasury_;
        actors.push(address(uint160(0x1001)));
        actors.push(address(uint160(0x1002)));
        actors.push(address(uint160(0x1003)));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _direction(uint256 seed) internal view returns (Token source, Token target) {
        return seed % 2 == 0 ? (play, gold) : (gold, play);
    }

    /// The treasury setting or updating a rate, always within the loop-guard
    /// ceiling so the call itself never reverts.
    function setPair(uint256 dirSeed, uint256 rateSeed) public {
        (Token source, Token target) = _direction(dirSeed);
        (uint256 reverseRate,, bool reverseExists) = conv.pair(address(target), address(source));

        uint256 maxRate = 4e18;
        if (reverseExists) {
            // Keep product <= RATE_SCALE^2 so setPair cannot trip its own guard.
            uint256 cap = (1e18 * 1e18) / reverseRate; // >= 2.5e17 since reverseRate <= 4e18
            if (cap < maxRate) maxRate = cap;
        }
        uint256 rate = bound(rateSeed, 1, maxRate);

        vm.prank(treasury);
        conv.setPair(address(source), address(target), rate);
    }

    function setPaused(uint256 dirSeed, uint256 flag) public {
        (Token source, Token target) = _direction(dirSeed);
        (,, bool exists) = conv.pair(address(source), address(target));
        if (!exists) return;
        vm.prank(treasury);
        conv.setPaused(address(source), address(target), flag % 2 == 0);
    }

    /// The treasury minting fresh supply to a wallet: the sanctioned top-up path.
    function faucet(uint256 actorSeed, uint256 tokenSeed, uint256 amountSeed) public {
        Token token = tokenSeed % 2 == 0 ? play : gold;
        address who = _actor(actorSeed);
        uint256 amount = bound(amountSeed, 0, 1e24);

        vm.prank(treasury);
        token.mint(who, amount);

        faucetTotal += amount;
        entitlement[who][address(token)] += amount;
    }

    /// A wallet converting its own balance. Guarded to the exact window in which
    /// convert succeeds: existing, unpaused pair, non-zero amountOut, amountIn
    /// within balance.
    function convert(uint256 actorSeed, uint256 dirSeed, uint256 amountSeed) public {
        (Token source, Token target) = _direction(dirSeed);
        address who = _actor(actorSeed);
        uint256 amountIn = _feasibleAmountIn(who, source, target, amountSeed);
        if (amountIn == 0) return;
        _doConvert(who, source, target, amountIn);
    }

    /// An actor round-tripping A->B->A. Both directions must exist and be
    /// unpaused, and both legs must mint at least one unit. Verifies the money
    /// property directly: value out of the cycle must not exceed value in.
    function roundTrip(uint256 actorSeed, uint256 dirSeed, uint256 amountSeed) public {
        (Token source, Token target) = _direction(dirSeed);
        (uint256 rateFwd, bool pausedFwd, bool existsFwd) = conv.pair(address(source), address(target));
        (uint256 rateBack, bool pausedBack, bool existsBack) = conv.pair(address(target), address(source));
        if (!existsFwd || !existsBack || pausedFwd || pausedBack) return;

        address who = _actor(actorSeed);
        uint256 amountIn = _feasibleAmountIn(who, source, target, amountSeed);
        if (amountIn == 0) return;

        // Second leg must also mint at least one unit, or the cycle can't close.
        uint256 mid = amountIn * rateFwd / 1e18;
        if (mid * rateBack / 1e18 == 0) return;

        uint256 got = _doConvert(who, source, target, amountIn);
        uint256 back = _doConvert(who, target, source, got);
        if (back > amountIn) roundTripMintedValue++;
    }

    /// The smallest-to-balance amountIn window that makes a single convert
    /// succeed, or 0 if none is possible.
    function _feasibleAmountIn(address who, Token source, Token target, uint256 amountSeed)
        internal
        view
        returns (uint256)
    {
        (uint256 rate, bool paused, bool exists) = conv.pair(address(source), address(target));
        if (!exists || paused) return 0;
        uint256 balance = source.balanceOf(who);
        if (balance == 0) return 0;
        uint256 minIn = (1e18 + rate - 1) / rate; // ceil(RATE_SCALE / rate), mints >= 1
        if (minIn == 0) minIn = 1;
        if (balance < minIn) return 0;
        return bound(amountSeed, minIn, balance);
    }

    /// Executes one convert and keeps the ledger and supply accounting in step
    /// with it. Callers guarantee the call succeeds.
    function _doConvert(address who, Token source, Token target, uint256 amountIn)
        internal
        returns (uint256 amountOut)
    {
        (uint256 rate,,) = conv.pair(address(source), address(target));
        amountOut = amountIn * rate / 1e18; // identical to the contract; >= 1
        vm.prank(who);
        conv.convert(address(source), address(target), amountIn, bytes32(0));
        entitlement[who][address(target)] += amountOut;
        convertNetDelta += int256(amountOut) - int256(amountIn);
    }

    /// UNGUARDED (try/catch): attempts to set a reverse rate that WOULD let a
    /// round trip mint value, which the loop guard must refuse. Without this the
    /// I1 invariant is decoration — the guarded setPair above never asks for a
    /// violating pair, so a dropped guard would never be exercised.
    function attemptLoopMintingPair(uint256 dirSeed, uint256 rateSeed) public {
        (Token source, Token target) = _direction(dirSeed);
        (uint256 forwardRate,, bool forwardExists) = conv.pair(address(source), address(target));
        if (!forwardExists) return;

        // Any reverse rate strictly above this makes forward*reverse > 1e36.
        uint256 minBad = (1e18 * 1e18) / forwardRate + 1;
        if (minBad > conv.MAX_RATE()) return; // not expressible below MAX_RATE
        uint256 reverseRate = bound(rateSeed, minBad, conv.MAX_RATE());

        vm.prank(treasury);
        try conv.setPair(address(target), address(source), reverseRate) {
            loopMintingPairAccepted++;
        } catch {
            // LoopMintsValue (or RateTooHigh): the correct refusal.
        }
    }
}

/// @title Invariants that must hold however the Converter is driven.
contract ConverterInvariantsTest is Test {
    Converter internal conv;
    Token internal play;
    Token internal gold;
    ConverterHandler internal handler;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        play = new Token("Play", "PLAY", treasury);
        gold = new Token("Gold", "GOLD", treasury);
        conv = new Converter(treasury);

        vm.startPrank(treasury);
        play.grantRole(play.BURNER_ROLE(), address(conv));
        play.grantRole(play.MINTER_ROLE(), address(conv));
        gold.grantRole(gold.BURNER_ROLE(), address(conv));
        gold.grantRole(gold.MINTER_ROLE(), address(conv));
        vm.stopPrank();

        handler = new ConverterHandler(conv, play, gold, treasury);
        targetContract(address(handler));
    }

    /// I1: no pair with both directions set ever has a rate product above 1e36,
    /// and no attempt to create such a pair ever succeeded.
    function invariant_noPairEverMintsValueOnARoundTrip() public view {
        (uint256 rateAB,, bool abExists) = conv.pair(address(play), address(gold));
        (uint256 rateBA,, bool baExists) = conv.pair(address(gold), address(play));
        if (abExists && baExists) {
            assertLe(rateAB * rateBA, 1e18 * 1e18, "a both-directions pair can mint value on a round trip");
        }
        assertEq(handler.loopMintingPairAccepted(), 0, "the loop guard accepted a value-minting reverse rate");
    }

    /// I2: no A->B->A round trip the handler executed ever returned more than it
    /// put in — the money property the loop guard exists to guarantee.
    function invariant_noRoundTripReturnsMoreThanItPutIn() public view {
        assertEq(handler.roundTripMintedValue(), 0, "a round trip returned more than it put in");
    }

    /// I4: total supply across both tokens equals what the faucet minted plus the
    /// net minted-minus-burned by every convert — an equality, so it proves
    /// convert moves supply by exactly amountOut/amountIn and nothing else does.
    function invariant_supplyIsFaucetPlusConvertNet() public view {
        int256 sum = int256(play.totalSupply() + gold.totalSupply());
        assertEq(sum, int256(handler.faucetTotal()) + handler.convertNetDelta(), "supply drifted from faucet + convert net");
    }

    /// I3: no account's balance of either token ever exceeds what the faucet gave
    /// it plus what conversions minted to it.
    function invariant_noBalanceExceedsItsEntitlement() public view {
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            address who = handler.actors(i);
            assertLe(
                play.balanceOf(who), handler.entitlement(who, address(play)), "play balance exceeds entitlement"
            );
            assertLe(
                gold.balanceOf(who), handler.entitlement(who, address(gold)), "gold balance exceeds entitlement"
            );
        }
    }
}
