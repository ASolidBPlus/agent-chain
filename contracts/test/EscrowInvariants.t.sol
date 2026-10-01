// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";
import {NameRegistry} from "../src/NameRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {JudgeHook} from "../src/JudgeHook.sol";

/// Creates, completes and refunds escrows across two tokens, two creators and two
/// judging modes, moving time in between. Every call that reverts is caught,
/// so the fuzzer explores refusals as well as successes.
contract EscrowHandler is Test {
    Escrow public escrow;
    JudgeHook public hook;
    Token[2] public tokens;

    string[3] internal aliases = ["alpha", "beta", "gamma"];
    address[3] public treasuries;
    address[3] public judges;
    address public stranger = address(0xE1);

    bytes32[] public ids;
    mapping(bytes32 => uint256) public settlements;
    mapping(bytes32 => uint256) public amountAtCreate;
    mapping(bytes32 => uint256) public paidOut;

    constructor(Escrow escrow_, JudgeHook hook_, Token a, Token b, address[3] memory treasuries_, address[3] memory judges_) {
        escrow = escrow_;
        hook = hook_;
        tokens = [a, b];
        treasuries = treasuries_;
        judges = judges_;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function create(uint256 who, uint256 tokenSeed, uint256 amountSeed, uint256 modeSeed, uint256 lifetime) public {
        uint256 c = who % 3;
        Token token = tokens[tokenSeed % 2];
        uint256 amount = bound(amountSeed, 0, token.balanceOf(treasuries[c]) + 1);
        bytes memory hookData = abi.encodePacked(uint8(modeSeed % 3), "judge");
        uint64 deadline = uint64(block.timestamp + bound(lifetime, 0, 3 days));
        bytes32 id = keccak256(abi.encode(ids.length, who, block.timestamp));

        vm.prank(treasuries[c]);
        try escrow.create(id, aliases[c], address(token), amount, address(hook), hookData, deadline) {
            ids.push(id);
            amountAtCreate[id] = amount;
        } catch {}
    }

    function complete(uint256 idSeed, uint256 reporter, uint256 winnerSeed) public {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        uint256 w = winnerSeed % 3;
        (,, address token,,,,,,,,) = escrow.get(id);
        uint256 before = Token(token).balanceOf(treasuries[w]);

        vm.prank(reporter % 4 == 3 ? stranger : judges[reporter % 4]);
        try escrow.complete(id, aliases[w], "") {
            settlements[id]++;
            paidOut[id] += Token(token).balanceOf(treasuries[w]) - before;
        } catch {}
    }

    function refund(uint256 idSeed) public {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        (, address creator, address token,,,,,,,,) = escrow.get(id);
        uint256 before = Token(token).balanceOf(creator);

        vm.prank(stranger);
        try escrow.refund(id) {
            settlements[id]++;
            paidOut[id] += Token(token).balanceOf(creator) - before;
        } catch {}
    }

    function wait(uint256 secondsSeed) public {
        vm.warp(block.timestamp + bound(secondsSeed, 0, 2 days));
        vm.roll(block.number + 1);
    }
}

contract EscrowInvariantsTest is Test {
    NameRegistry names;
    Escrow escrow;
    JudgeHook hook;
    Token play;
    Token gold;
    EscrowHandler handler;

    address admin = address(0xA11CE);
    uint256[2] supplyAtStart;

    function setUp() public {
        vm.warp(1_000_000);
        names = new NameRegistry(admin);
        escrow = new Escrow(address(names));
        hook = new JudgeHook(address(names));
        play = new Token("Play", "PLAY", admin);
        gold = new Token("Gold", "GOLD", admin);

        address[3] memory treasuries = [address(0xA1), address(0xB1), address(0xC1)];
        address[3] memory judges = [address(0xA2), address(0xB2), address(0xC2)];
        string[3] memory aliases = ["alpha", "beta", "gamma"];

        vm.startPrank(admin);
        for (uint256 t = 0; t < 2; t++) {
            Token token = t == 0 ? play : gold;
            token.grantRole(token.BURNER_ROLE(), address(escrow));
            token.grantRole(token.MINTER_ROLE(), address(escrow));
            for (uint256 i = 0; i < 3; i++) {
                token.mint(treasuries[i], 1_000e18);
            }
        }
        for (uint256 i = 0; i < 3; i++) {
            names.registerFor(string.concat(aliases[i], ":treasury"), treasuries[i], treasuries[i]);
            names.registerFor(string.concat(aliases[i], ":judge"), judges[i], judges[i]);
        }
        vm.stopPrank();

        supplyAtStart = [play.totalSupply(), gold.totalSupply()];
        handler = new EscrowHandler(escrow, hook, play, gold, treasuries, judges);
        targetContract(address(handler));
    }

    /// Each escrow settles at most once, a settled one exactly once, and the
    /// settlement pays exactly the amount stored at create.
    function invariant_eachEscrowSettlesExactlyOnceForItsAmount() public view {
        for (uint256 i = 0; i < handler.idCount(); i++) {
            bytes32 id = handler.ids(i);
            (,,, uint256 amount,,,, uint8 state,,,) = escrow.get(id);
            assertEq(amount, handler.amountAtCreate(id), "stored amount changed");
            if (state == 1) {
                assertEq(handler.settlements(id), 0, "an open escrow has settled");
            } else {
                assertEq(handler.settlements(id), 1, "a settled escrow did not settle exactly once");
                assertEq(handler.paidOut(id), amount, "a settlement paid something other than its amount");
            }
        }
    }

    /// Per token: minted by escrow == burned by escrow - currently locked. Only the
    /// escrow mints or burns after setUp, so the supply drop is burned - minted.
    function invariant_mintedEqualsBurnedMinusLocked() public view {
        uint256[2] memory locked;
        for (uint256 i = 0; i < handler.idCount(); i++) {
            (,, address token, uint256 amount,,,, uint8 state,,,) = escrow.get(handler.ids(i));
            if (state == 1) locked[token == address(play) ? 0 : 1] += amount;
        }
        assertEq(supplyAtStart[0] - play.totalSupply(), locked[0], "play: minted != burned - locked");
        assertEq(supplyAtStart[1] - gold.totalSupply(), locked[1], "gold: minted != burned - locked");
    }

    /// The escrow never holds a balance: locked money is out of supply, not parked.
    function invariant_escrowHoldsNothing() public view {
        assertEq(play.balanceOf(address(escrow)), 0);
        assertEq(gold.balanceOf(address(escrow)), 0);
    }
}
