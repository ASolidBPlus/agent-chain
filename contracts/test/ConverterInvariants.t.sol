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

    /// Must stay zero: a FROZEN account's send must never be accepted. Counted
    /// rather than asserted at the call site because a Foundry invariant reads
    /// STATE, not logs - `vm.expectRevert` inside a handler action proves
    /// nothing to the invariant runner.
    uint256 public frozenSendAccepted;
    /// How many times `attemptFrozenSend` actually reached a frozen sender.
    /// Read by a DETERMINISTIC test rather than by the invariant runner, which
    /// reverts handler state between runs and so cannot see it - see
    /// FreezeHandlerReachabilityTest below.
    uint256 public frozenSendAttempted;

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
        // Both legs burn from `who`, so a frozen actor cannot round-trip either.
        // `_feasibleAmountIn` already refuses the first leg; this makes the skip
        // explicit at the second, where the source token is the other one.
        if (source.frozen(who) || target.frozen(who)) return;
        uint256 amountIn = _feasibleAmountIn(who, source, target, amountSeed);
        if (amountIn == 0) return;

        // Second leg must also mint at least one unit, or the cycle can't close.
        uint256 mid = amountIn * rateFwd / 1e18;
        if (mid * rateBack / 1e18 == 0) return;

        uint256 got = _doConvert(who, source, target, amountIn);
        uint256 back = _doConvert(who, target, source, got);
        if (back > amountIn) roundTripMintedValue++;
    }

    /// Freeze or unfreeze one actor. GUARDED only in the sense that it cannot
    /// revert: the treasury holds FREEZER_ROLE, and `setFrozen` is idempotent,
    /// so every call in the sequence succeeds and `fail_on_revert` is satisfied.
    ///
    /// FROZEN ACTORS ACCUMULATE over a sequence - `attemptFrozenSend` freezes
    /// one when none is frozen, and only `freeze(seed, false)` lifts it. So the
    /// coverage I1-I4 lose is bounded: a frozen actor stops converting, and
    /// with three actors and a fuzzed bool the sequence keeps unfreezing them.
    /// Worth knowing rather than worth preventing - the alternative, reverting
    /// the freeze after each attempt, would make the state unreachable by the
    /// rest of the sequence, which is the defect this action was rewritten to
    /// fix.
    ///
    /// This is what makes the frozen state REACHABLE by the rest of the
    /// sequence. Without it `frozenSendAccepted` could only ever be zero because
    /// nothing was ever frozen - the counter would sit at 0 for the wrong
    /// reason and the invariant would pass vacuously.
    function freeze(uint256 actorSeed, bool value) public {
        address who = _actor(actorSeed);
        vm.prank(treasury);
        play.setFrozen(who, value);
        vm.prank(treasury);
        gold.setFrozen(who, value);
    }

    /// UNGUARDED (try/catch): a frozen actor attempting to send. The freeze must
    /// refuse it; if the send is ACCEPTED the counter moves and the invariant
    /// fails.
    ///
    /// Modelled on `attemptLoopMintingPair` and there for the same reason: the
    /// guarded actions below all SKIP a frozen actor, so a dropped freeze would
    /// never be exercised by them and the property would be decoration.
    function attemptFrozenSend(uint256 actorSeed, uint256 amountSeed) public {
        // SEARCHES for a frozen actor rather than picking one by seed.
        //
        // The first version took `_actor(actorSeed)` and asked whether THAT one
        // was frozen. It never was: `freeze` picks its actor from a different
        // seed, so the two agreed only by coincidence, and a vacuity check
        // showed the frozen branch was reached ZERO times in 8192 calls. The
        // counter sat at 0 because nothing was ever attempted, not because
        // everything was refused - the invariant was decoration and would have
        // passed with the freeze deleted.
        //
        // Starting the scan at `actorSeed` keeps the fuzzer's influence over
        // WHICH frozen actor is chosen when several are, while removing its
        // ability to make the answer "none" when one exists.
        address who = address(0);
        for (uint256 i = 0; i < actors.length; i++) {
            // REDUCED BEFORE THE ADDITION. `actorSeed + i` overflows when the
            // fuzzer supplies type(uint256).max, and an overflow in a GUARDED
            // action is a revert, which fail_on_revert correctly treats as a
            // finding. Found by the fuzzer on its first shrink.
            address candidate = actors[(actorSeed % actors.length + i) % actors.length];
            if (play.frozen(candidate) && play.balanceOf(candidate) > 0) {
                who = candidate;
                break;
            }
        }
        // IF NOBODY IS FROZEN, FREEZE SOMEBODY. The state this action exists to
        // exercise must not depend on two independent fuzz seeds agreeing:
        // measured, they never did, and the branch was reached zero times in
        // 8192 calls while the invariant reported success.
        //
        // The freeze is left in place rather than reverted, so the rest of the
        // sequence runs against it and the `freeze` action can lift it like any
        // other. This makes the state reachable by construction; it does not
        // make the SEND succeed, which is the thing under test.
        if (who == address(0)) {
            for (uint256 i = 0; i < actors.length; i++) {
                address candidate = actors[(actorSeed % actors.length + i) % actors.length];
                if (play.balanceOf(candidate) > 0) {
                    who = candidate;
                    vm.prank(treasury);
                    play.setFrozen(who, true);
                    break;
                }
            }
            if (who == address(0)) return;
        }
        uint256 balance = play.balanceOf(who);
        uint256 amount = bound(amountSeed, 1, balance);
        frozenSendAttempted++;

        vm.prank(who);
        try play.transfer(address(0xDEAD), amount) {
            frozenSendAccepted++;
        } catch {
            // AccountFrozen: the correct refusal.
        }
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
        // A FROZEN ACTOR CANNOT CONVERT: the Converter burns the source from
        // `who`, and a burn is a send. Returning 0 here is what keeps every
        // GUARDED action revert-free under fail_on_revert; the freeze property
        // itself is proven by the unguarded `attemptFrozenSend` instead.
        if (source.frozen(who)) return 0;
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

    /// I5: a FROZEN account's send was never accepted, however the sequence
    /// drove it.
    ///
    /// Asserts the COUNTER, not the mapping: the mapping says who is frozen
    /// NOW, and the sequence freezes and unfreezes, so a state assertion would
    /// be about the last call rather than about every send in between. The
    /// counter is the only thing here that remembers.
    function invariant_aFrozenAccountNeverSent() public view {
        assertEq(handler.frozenSendAccepted(), 0, "a frozen account's send was accepted");
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

/// @title The freeze action is REACHABLE, proven deterministically.
/// @notice `invariant_aFrozenAccountNeverSent` asserts a counter stays zero, and
/// a counter stays zero just as well when nothing ever tried. That is not a
/// hypothetical: the first version of `attemptFrozenSend` picked its actor from
/// its own fuzz seed and asked whether THAT one was frozen, while `freeze`
/// picked from a different seed - measured, the frozen branch was reached ZERO
/// times in 8192 calls and the invariant passed. It would have passed with the
/// freeze deleted from the token.
///
/// @dev The reachability cannot be asserted inside the invariant machinery:
/// `invariant_` functions run after EVERY call, where "was this ever reached" is
/// false by construction after call one, and `afterInvariant` runs once against
/// reverted handler state, where the counters read zero. Both were tried. So the
/// guard on the guard is this: drive the handler directly, in a fixed order, and
/// assert the branch was entered and the send refused.
contract FreezeHandlerReachabilityTest is Test {
    Token internal play;
    Token internal gold;
    Converter internal conv;
    ConverterHandler internal handler;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        play = new Token("Play Token", "PLAY", treasury);
        gold = new Token("Gold Token", "GOLD", treasury);
        conv = new Converter(treasury);
        vm.startPrank(treasury);
        play.grantRole(play.BURNER_ROLE(), address(conv));
        play.grantRole(play.MINTER_ROLE(), address(conv));
        gold.grantRole(gold.BURNER_ROLE(), address(conv));
        gold.grantRole(gold.MINTER_ROLE(), address(conv));
        vm.stopPrank();
        handler = new ConverterHandler(conv, play, gold, treasury);
    }

    function test_TheFrozenSendBranchIsEnteredAndRefused() public {
        // An actor with a balance, and nobody frozen yet.
        handler.faucet(0, 0, 1_000e18);
        assertEq(handler.frozenSendAttempted(), 0, "nothing attempted before the first call");

        // The action must reach a frozen sender even though NOTHING froze one -
        // it freezes by construction rather than waiting for a seed collision.
        handler.attemptFrozenSend(0, 12345);
        assertGt(handler.frozenSendAttempted(), 0, "the frozen-send branch was never entered");
        assertEq(handler.frozenSendAccepted(), 0, "a frozen account's send was accepted");
    }

    function test_ItAlsoReachesOneTheSequenceFroze() public {
        // The other route in: an actor frozen by the `freeze` action, found by
        // the scan rather than by the seeds agreeing.
        handler.faucet(2, 0, 500e18);
        handler.freeze(2, true);
        handler.attemptFrozenSend(0, 999);
        assertGt(handler.frozenSendAttempted(), 0, "the scan did not find the frozen actor");
        assertEq(handler.frozenSendAccepted(), 0, "a frozen account's send was accepted");
    }
}
