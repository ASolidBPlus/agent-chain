// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";
import {NameRegistry} from "../src/NameRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {JudgeHook} from "../src/JudgeHook.sol";
import {IEscrowHook} from "../src/IEscrowHook.sol";

/// A hook that tries to write. Escrow calls hooks through a view interface, so the
/// write runs inside a staticcall and reverts.
contract WritingHook {
    uint256 public calls;

    function check(bytes calldata, string calldata, string calldata, address) external returns (bool) {
        calls++;
        return true;
    }
}

/// A token that serves the escrow and re-enters it from `mint`, to show that
/// state is written before the mint.
contract ReentrantToken {
    Escrow public escrow;
    bytes32 public target;
    bool public reentered;
    bytes4 public reentryError;

    function arm(Escrow escrow_, bytes32 id) external {
        escrow = escrow_;
        target = id;
    }

    function hasRole(bytes32, address) external pure returns (bool) {
        return true;
    }

    function burnFrom(address, uint256) external {}

    function mint(address, uint256) external {
        if (address(escrow) == address(0)) return;
        try escrow.refund(target) {
            reentered = true;
        } catch (bytes memory reason) {
            reentryError = bytes4(reason);
        }
        try escrow.complete(target, "winner", "") {
            reentered = true;
        } catch {}
    }
}

contract EscrowTest is Test {
    NameRegistry names;
    Token play;
    Escrow escrow;
    JudgeHook judge;

    address admin = address(0xA11CE);
    address creator = address(0xC1);
    address creatorJudge = address(0xC2);
    address winner = address(0xD1);
    address winnerJudge = address(0xD2);
    address stranger = address(0xE1);

    bytes32 constant ID = keccak256("escrow-1");
    bytes constant JUDGE = hex"006a75646765"; // mode 0, "judge"
    bytes constant EACH_JUDGE = hex"016a75646765"; // mode 1, "judge"
    uint256 constant AMOUNT = 100e18;

    function setUp() public {
        vm.warp(1_000_000);
        names = new NameRegistry(admin);
        play = new Token("Play", "PLAY", admin);
        escrow = new Escrow(address(names));
        judge = new JudgeHook(address(names));

        vm.startPrank(admin);
        play.grantRole(play.BURNER_ROLE(), address(escrow));
        play.grantRole(play.MINTER_ROLE(), address(escrow));
        play.mint(creator, 1_000e18);
        names.registerFor("maker:treasury", creator, creator);
        names.registerFor("maker:judge", creatorJudge, creatorJudge);
        names.registerFor("winner:treasury", winner, winner);
        names.registerFor("winner:judge", winnerJudge, winnerJudge);
        vm.stopPrank();
    }

    function _create(bytes memory hookData, uint64 deadline) internal {
        vm.prank(creator);
        escrow.create(ID, "maker", address(play), AMOUNT, address(judge), hookData, deadline);
    }

    function _state(bytes32 id) internal view returns (uint8 state) {
        (,,,,,,, state,,,) = escrow.get(id);
    }

    // ── create ──────────────────────────────────────────────────────────────

    function test_CreateBurnsFromTheCreatorAndStoresEverything() public {
        uint256 supply = play.totalSupply();
        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit Escrow.Created(ID, "maker", address(play), AMOUNT, address(judge), deadline);
        _create(JUDGE, deadline);

        assertEq(play.balanceOf(creator), 900e18);
        assertEq(play.totalSupply(), supply - AMOUNT);
        (
            string memory creatorAlias,
            address creator_,
            address token,
            uint256 amount,
            address hook,
            bytes memory hookData,
            uint64 deadline_,
            uint8 state,
            string memory winnerAlias,
            string memory winnerAccount,
            uint64 now_
        ) = escrow.get(ID);
        assertEq(creatorAlias, "maker");
        assertEq(creator_, creator);
        assertEq(token, address(play));
        assertEq(amount, AMOUNT);
        assertEq(hook, address(judge));
        assertEq(hookData, JUDGE);
        assertEq(deadline_, deadline);
        assertEq(state, 1);
        assertEq(winnerAlias, "");
        assertEq(winnerAccount, "");
        assertEq(now_, block.timestamp);
    }

    function test_CreateRefusesAnIdInUse() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creator);
        vm.expectRevert(Escrow.Exists.selector);
        escrow.create(ID, "maker", address(play), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1 days));
    }

    function test_CreateRefusesAnIdThatHasSettled() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 1 days + 1);
        escrow.refund(ID);
        vm.prank(creator);
        vm.expectRevert(Escrow.Exists.selector);
        escrow.create(ID, "maker", address(play), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1 days));
    }

    function test_CreateRefusesZero() public {
        vm.prank(creator);
        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.create(ID, "maker", address(play), 0, address(judge), JUDGE, uint64(block.timestamp + 1));
    }

    function test_CreateRefusesADeadlineThatIsNowOrPast() public {
        vm.startPrank(creator);
        vm.expectRevert(Escrow.BadDeadline.selector);
        escrow.create(ID, "maker", address(play), AMOUNT, address(judge), JUDGE, uint64(block.timestamp));
        vm.expectRevert(Escrow.BadDeadline.selector);
        escrow.create(ID, "maker", address(play), AMOUNT, address(judge), JUDGE, uint64(block.timestamp - 1));
        vm.stopPrank();
        escrow.get(ID); // nothing stored
        assertEq(_state(ID), 0);
    }

    function test_CreateRefusesTheCreatorsJudgeWallet() public {
        vm.prank(creatorJudge);
        vm.expectRevert(Escrow.NotCreator.selector);
        escrow.create(ID, "maker", address(play), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));
    }

    function test_CreateRefusesAnotherAlias() public {
        vm.prank(creator);
        vm.expectRevert(Escrow.NotCreator.selector);
        escrow.create(ID, "winner", address(play), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));
    }

    function test_CreateRefusesAnUnregisteredAlias() public {
        vm.prank(creator);
        vm.expectRevert(Escrow.NotCreator.selector);
        escrow.create(ID, "nobody", address(play), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));
    }

    function test_CreateRefusesAHookWithNoCode() public {
        vm.prank(creator);
        vm.expectRevert(Escrow.BadHook.selector);
        escrow.create(ID, "maker", address(play), AMOUNT, stranger, JUDGE, uint64(block.timestamp + 1));
    }

    function test_CreateRefusesATokenMissingEitherRole() public {
        Token bare = new Token("Bare", "BARE", admin);
        bytes32 burner = bare.BURNER_ROLE();
        bytes32 minter = bare.MINTER_ROLE();
        vm.prank(creator);
        vm.expectRevert(Escrow.UnknownToken.selector);
        escrow.create(ID, "maker", address(bare), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));

        vm.prank(admin);
        bare.grantRole(burner, address(escrow));
        vm.prank(creator);
        vm.expectRevert(Escrow.UnknownToken.selector);
        escrow.create(ID, "maker", address(bare), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));

        vm.startPrank(admin);
        bare.revokeRole(burner, address(escrow));
        bare.grantRole(minter, address(escrow));
        vm.stopPrank();
        vm.prank(creator);
        vm.expectRevert(Escrow.UnknownToken.selector);
        escrow.create(ID, "maker", address(bare), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));
    }

    function test_CreateRefusesAContractThatIsNotAToken() public {
        vm.prank(creator);
        vm.expectRevert(Escrow.UnknownToken.selector);
        escrow.create(ID, "maker", address(judge), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));
    }

    function test_CreateRefusesAnAddressWithNoCodeAsToken() public {
        vm.prank(creator);
        vm.expectRevert(Escrow.UnknownToken.selector);
        escrow.create(ID, "maker", stranger, AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));
    }

    function test_CreateRevertsWholeWhenTheBurnFails() public {
        vm.prank(creator);
        vm.expectRevert();
        escrow.create(ID, "maker", address(play), 1_001e18, address(judge), JUDGE, uint64(block.timestamp + 1));
        assertEq(_state(ID), 0);
        assertEq(play.balanceOf(creator), 1_000e18);
    }

    function test_CreateRefusesAFrozenCreator() public {
        vm.prank(admin);
        play.setFrozen(creator, true);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Token.AccountFrozen.selector, creator));
        escrow.create(ID, "maker", address(play), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));
        assertEq(_state(ID), 0);
    }

    // ── complete ────────────────────────────────────────────────────────────

    function test_CompletePaysTheWinnersTreasury() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        uint256 supply = play.totalSupply();
        vm.expectEmit(true, false, false, true, address(escrow));
        emit Escrow.Completed(ID, "winner", "", AMOUNT);
        vm.prank(creatorJudge);
        escrow.complete(ID, "winner", "");

        assertEq(play.balanceOf(winner), AMOUNT);
        assertEq(play.balanceOf(creatorJudge), 0);
        assertEq(play.totalSupply(), supply + AMOUNT);
        (,,,,,,, uint8 state, string memory winnerAlias, string memory winnerAccount,) = escrow.get(ID);
        assertEq(state, 2);
        assertEq(winnerAlias, "winner");
        assertEq(winnerAccount, "");
    }

    function test_CompletePaysANamedAccountOfTheWinner() public {
        address vault = address(0xD3);
        vm.prank(admin);
        names.registerFor("winner:acc.vault", vault, vault);
        _create(JUDGE, uint64(block.timestamp + 1 days));

        vm.expectEmit(true, false, false, true, address(escrow));
        emit Escrow.Completed(ID, "winner", "vault", AMOUNT);
        vm.prank(creatorJudge);
        escrow.complete(ID, "winner", "vault");

        assertEq(play.balanceOf(vault), AMOUNT);
        assertEq(play.balanceOf(winner), 0);
        (,,,,,,, uint8 state, string memory winnerAlias, string memory winnerAccount,) = escrow.get(ID);
        assertEq(state, 2);
        assertEq(winnerAlias, "winner");
        assertEq(winnerAccount, "vault");
    }

    function test_AnEmptyAccountPaysTheTreasuryEvenWhenAccountsExist() public {
        vm.prank(admin);
        names.registerFor("winner:acc.vault", address(0xD3), address(0xD3));
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        escrow.complete(ID, "winner", "");
        assertEq(play.balanceOf(winner), AMOUNT);
        assertEq(play.balanceOf(address(0xD3)), 0);
    }

    function test_AnUnknownAccountIsAnUnknownWinner() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        vm.expectRevert(Escrow.UnknownWinner.selector);
        escrow.complete(ID, "winner", "nope");
        assertEq(_state(ID), 1);
    }

    // The account name is built from winnerAlias, so naming an account that
    // belongs to another participant resolves under the winner and misses.
    function test_AnotherParticipantsAccountCannotBePaid() public {
        address makerVault = address(0xC3);
        vm.prank(admin);
        names.registerFor("maker:acc.vault", makerVault, makerVault);
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        vm.expectRevert(Escrow.UnknownWinner.selector);
        escrow.complete(ID, "winner", "vault");
        assertEq(play.balanceOf(makerVault), 0);
    }

    // With both participants holding an account of the same name, the winner's
    // is paid.
    function test_TheWinnersAccountIsPaidNotTheCreatorsOfTheSameName() public {
        address makerVault = address(0xC3);
        address winnerVault = address(0xD3);
        vm.startPrank(admin);
        names.registerFor("maker:acc.vault", makerVault, makerVault);
        names.registerFor("winner:acc.vault", winnerVault, winnerVault);
        vm.stopPrank();
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        escrow.complete(ID, "winner", "vault");
        assertEq(play.balanceOf(winnerVault), AMOUNT);
        assertEq(play.balanceOf(makerVault), 0);
    }

    // The hook judges winnerAlias only: in mode 1 the winner's own judge may
    // report, whatever account it names.
    function test_TheAccountDoesNotChangeWhoMayJudge() public {
        address vault = address(0xD3);
        vm.prank(admin);
        names.registerFor("winner:acc.vault", vault, vault);
        _create(EACH_JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        vm.expectRevert(Escrow.HookRefused.selector);
        escrow.complete(ID, "winner", "vault");
        vm.prank(winnerJudge);
        escrow.complete(ID, "winner", "vault");
        assertEq(play.balanceOf(vault), AMOUNT);
    }

    function test_CompleteRefusesAnUnknownId() public {
        vm.prank(creatorJudge);
        vm.expectRevert(Escrow.NotOpen.selector);
        escrow.complete(ID, "winner", "");
    }

    function test_FirstReportWinsAndTheNextBlockIsRefused() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        escrow.complete(ID, "winner", "");

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
        vm.prank(creatorJudge);
        vm.expectRevert(Escrow.NotOpen.selector);
        escrow.complete(ID, "maker", "");
        assertEq(play.balanceOf(winner), AMOUNT);
        assertEq(play.balanceOf(creator), 900e18);
    }

    function test_CompleteRefusesARefundedEscrow() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 1 days + 1);
        escrow.refund(ID);
        vm.prank(creatorJudge);
        vm.expectRevert(Escrow.NotOpen.selector);
        escrow.complete(ID, "winner", "");
    }

    function test_CompleteRefusesAReporterTheHookRejects() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        address[3] memory others = [winnerJudge, creator, stranger];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(Escrow.HookRefused.selector);
            escrow.complete(ID, "winner", "");
        }
        assertEq(_state(ID), 1);
    }

    function test_CompleteRefusesAWinnerWithNoTreasury() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        vm.expectRevert(Escrow.UnknownWinner.selector);
        escrow.complete(ID, "nobody", "");
        assertEq(_state(ID), 1);
    }

    function test_CompleteCallsTheHookAsAView() public {
        WritingHook hook = new WritingHook();
        vm.prank(creator);
        escrow.create(ID, "maker", address(play), AMOUNT, address(hook), JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        vm.expectRevert();
        escrow.complete(ID, "winner", "");
        assertEq(hook.calls(), 0);
        assertEq(_state(ID), 1);
    }

    function test_ATokenNamedAsHookCanOnlyBeRefunded() public {
        vm.prank(creator);
        escrow.create(ID, "maker", address(play), AMOUNT, address(play), JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        vm.expectRevert();
        escrow.complete(ID, "winner", "");
        vm.warp(block.timestamp + 1 days + 1);
        escrow.refund(ID);
        assertEq(play.balanceOf(creator), 1_000e18);
    }

    // ── refund ──────────────────────────────────────────────────────────────

    function test_RefundByAnyoneAfterTheDeadlinePaysTheCreator() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit Escrow.Refunded(ID, "maker", AMOUNT);
        vm.prank(stranger);
        escrow.refund(ID);
        assertEq(play.balanceOf(creator), 1_000e18);
        assertEq(play.balanceOf(stranger), 0);
        assertEq(_state(ID), 3);
    }

    function test_RefundRefusesAnUnknownId() public {
        vm.expectRevert(Escrow.NotOpen.selector);
        escrow.refund(ID);
    }

    function test_RefundRefusesACompletedEscrow() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.prank(creatorJudge);
        escrow.complete(ID, "winner", "");
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(Escrow.NotOpen.selector);
        escrow.refund(ID);
    }

    function test_RefundRunsOnce() public {
        _create(JUDGE, uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 1 days + 1);
        escrow.refund(ID);
        vm.expectRevert(Escrow.NotOpen.selector);
        escrow.refund(ID);
        assertEq(play.balanceOf(creator), 1_000e18);
    }

    // ── the deadline, from both sides ───────────────────────────────────────

    function test_AtTheDeadlineCompleteSucceedsAndRefundIsNotYet() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        _create(JUDGE, deadline);
        vm.warp(deadline);
        vm.expectRevert(Escrow.NotYet.selector);
        escrow.refund(ID);
        vm.prank(creatorJudge);
        escrow.complete(ID, "winner", "");
        assertEq(_state(ID), 2);
    }

    function test_OneSecondAfterTheDeadlineCompleteIsTooLateAndRefundSucceeds() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        _create(JUDGE, deadline);
        vm.warp(uint256(deadline) + 1);
        vm.prank(creatorJudge);
        vm.expectRevert(Escrow.TooLate.selector);
        escrow.complete(ID, "winner", "");
        escrow.refund(ID);
        assertEq(_state(ID), 3);
    }

    // ── state before the mint ───────────────────────────────────────────────

    function test_StateIsSettledBeforeTheRefundMint() public {
        ReentrantToken token = new ReentrantToken();
        vm.prank(creator);
        escrow.create(ID, "maker", address(token), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));
        token.arm(escrow, ID);
        vm.warp(block.timestamp + 2);
        escrow.refund(ID);
        assertFalse(token.reentered());
        assertEq(token.reentryError(), Escrow.NotOpen.selector);
    }

    function test_StateIsSettledBeforeTheCompleteMint() public {
        ReentrantToken token = new ReentrantToken();
        vm.prank(creator);
        escrow.create(ID, "maker", address(token), AMOUNT, address(judge), JUDGE, uint64(block.timestamp + 1));
        token.arm(escrow, ID);
        vm.prank(creatorJudge);
        escrow.complete(ID, "winner", "");
        assertFalse(token.reentered());
        assertEq(token.reentryError(), Escrow.NotOpen.selector);
    }
}

contract JudgeHookTest is Test {
    NameRegistry names;
    JudgeHook hook;

    address admin = address(0xA11CE);
    address makerJudge = address(0xC2);
    address winnerJudge = address(0xD2);

    function setUp() public {
        names = new NameRegistry(admin);
        hook = new JudgeHook(address(names));
        vm.startPrank(admin);
        names.registerFor("maker:judge", makerJudge, makerJudge);
        names.registerFor("winner:judge", winnerJudge, winnerJudge);
        vm.stopPrank();
    }

    function test_GoldenVectorIsModeZeroAndJudge() public view {
        bytes memory golden = hex"006a75646765";
        assertEq(golden, abi.encodePacked(uint8(0), "judge"));
        assertTrue(hook.check(golden, "maker", "winner", makerJudge));
    }

    function test_ModeZeroAcceptsOnlyTheCreatorsJudge() public view {
        bytes memory data = hex"006a75646765";
        assertTrue(hook.check(data, "maker", "winner", makerJudge));
        assertFalse(hook.check(data, "maker", "winner", winnerJudge));
        assertFalse(hook.check(data, "maker", "maker", winnerJudge));
        assertFalse(hook.check(data, "nobody", "winner", makerJudge));
    }

    function test_ModeOneAcceptsOnlyTheWinnersOwnJudge() public view {
        bytes memory data = hex"016a75646765";
        assertTrue(hook.check(data, "maker", "winner", winnerJudge));
        assertFalse(hook.check(data, "maker", "winner", makerJudge));
        assertTrue(hook.check(data, "maker", "maker", makerJudge));
    }

    function test_TheBackendNameIsPartOfTheCheck() public view {
        assertFalse(hook.check(abi.encodePacked(uint8(0), "judges"), "maker", "winner", makerJudge));
        assertFalse(hook.check(abi.encodePacked(uint8(0), "treasury"), "maker", "winner", makerJudge));
    }

    function test_OtherModesAreRefused() public view {
        for (uint8 mode = 2; mode < 255; mode++) {
            assertFalse(hook.check(abi.encodePacked(mode, "judge"), "maker", "winner", makerJudge));
        }
        assertFalse(hook.check(abi.encodePacked(uint8(255), "judge"), "maker", "winner", makerJudge));
    }

    // A one-byte hookData would name the empty backend, which resolves
    // "<alias>:". That name is registrable, so register it: the length check
    // is then the only thing refusing.
    function test_ShortHookDataIsRefused() public {
        address emptyJudge = address(0xF1);
        vm.startPrank(admin);
        names.registerFor("maker:", emptyJudge, emptyJudge);
        names.registerFor("winner:", emptyJudge, emptyJudge);
        vm.stopPrank();
        assertFalse(hook.check("", "maker", "winner", emptyJudge));
        assertFalse(hook.check(hex"00", "maker", "winner", emptyJudge));
        assertFalse(hook.check(hex"01", "maker", "winner", emptyJudge));
    }

    // An unregistered judge name resolves to zero, which only a zero sender
    // matches; Escrow passes msg.sender, which is never zero.
    function test_AnUnregisteredJudgeAcceptsNoRealSender() public view {
        bytes memory absent = abi.encodePacked(uint8(0), "absent");
        assertFalse(hook.check(absent, "maker", "winner", makerJudge));
        assertFalse(hook.check(absent, "maker", "winner", winnerJudge));
        assertTrue(hook.check(absent, "maker", "winner", address(0)));
    }

    function test_ItImplementsTheHookInterface() public view {
        assertTrue(IEscrowHook(address(hook)).check(hex"006a75646765", "maker", "winner", makerJudge));
    }
}
