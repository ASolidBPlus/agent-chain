// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {NameRegistry} from "../src/NameRegistry.sol";

/// @title Property tests for the parts of NameRegistry an example cannot cover.
/// @notice The example-based suite proves the rules hold for the cases someone
/// thought of. These prove them for cases nobody did - specifically the charset
/// and length validators, where "the one character I forgot" is exactly the bug
/// an example suite cannot find.
///
/// The oracle below (`_shouldBeAllowed`) is a SECOND, INDEPENDENT statement of
/// the rule. That is the point: if it and `_validateName` ever disagree, one of
/// them is wrong and the test says which input found it. Do not "simplify" it
/// by calling into the contract - a test that asks the implementation whether
/// the implementation is right proves nothing.
contract NameRegistryPropertiesTest is Test {
    address internal treasury = makeAddr("treasury");
    address internal wallet = makeAddr("wallet");

    uint256 internal constant MIN_LENGTH = 3;
    uint256 internal constant MAX_LENGTH = 48;

    function _shouldBeAllowed(bytes1 c) internal pure returns (bool) {
        return (c >= 0x61 && c <= 0x7a) // a-z
            || (c >= 0x41 && c <= 0x5a) // A-Z
            || (c >= 0x30 && c <= 0x39) // 0-9
            || c == 0x2e // .
            || c == 0x5f // _
            || c == 0x40 // @
            || c == 0x3a // :
            || c == 0x2d; // -
    }

    function _repeat(bytes1 c, uint256 n) internal pure returns (string memory) {
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = c;
        }
        return string(out);
    }

    /// Every byte value, checked against an independent statement of the rule.
    /// Uppercase is in the allowed set deliberately: `aIpha.play` against
    /// `alpha.play` is a game mechanic, and a charset that rejected the capital
    /// would make it unregistrable (spec S3.2, ruled).
    function testFuzz_CharsetAcceptsExactlyTheAllowedBytes(uint8 raw) public {
        NameRegistry registry = new NameRegistry(treasury);
        bytes1 c = bytes1(raw);
        string memory name = string(abi.encodePacked("ab", c));

        if (_shouldBeAllowed(c)) {
            vm.prank(treasury);
            registry.registerFor(name, wallet, wallet);
            assertEq(registry.resolve(name), wallet, "an allowed character was rejected");
        } else {
            vm.prank(treasury);
            vm.expectRevert(abi.encodeWithSelector(NameRegistry.InvalidNameChar.selector, 2, c));
            registry.registerFor(name, wallet, wallet);
        }
    }

    /// A name is accepted iff its length is within the on-chain bounds. The
    /// bound matters off-chain too: chain-svc's 3-48 check on a qualified id
    /// exists so an over-long id is a 400 rather than a revert surfacing as 502.
    function testFuzz_LengthIsAcceptedExactlyWithinBounds(uint8 rawLength) public {
        uint256 length = bound(rawLength, 0, 60);
        NameRegistry registry = new NameRegistry(treasury);
        string memory name = _repeat("a", length);

        if (length < MIN_LENGTH) {
            vm.prank(treasury);
            vm.expectRevert(NameRegistry.NameTooShort.selector);
            registry.registerFor(name, wallet, wallet);
        } else if (length > MAX_LENGTH) {
            vm.prank(treasury);
            vm.expectRevert(NameRegistry.NameTooLong.selector);
            registry.registerFor(name, wallet, wallet);
        } else {
            vm.prank(treasury);
            registry.registerFor(name, wallet, wallet);
            assertEq(registry.resolve(name), wallet);
        }
    }

    /// Names are stored AS GIVEN - no normalisation, no case folding. Two names
    /// differing only in case are two different names owned by two different
    /// wallets, which is the phishing surface the game trades on.
    function testFuzz_CaseIsNeverFolded(uint8 rawIndex) public {
        NameRegistry registry = new NameRegistry(treasury);
        uint256 index = bound(rawIndex, 0, 25);

        bytes memory lower = bytes("abcdefg");
        lower[index % 7] = bytes1(uint8(0x61 + index));
        bytes memory upper = bytes("abcdefg");
        upper[index % 7] = bytes1(uint8(0x41 + index));

        address other = makeAddr("other");
        vm.prank(treasury);
        registry.registerFor(string(lower), wallet, wallet);
        vm.prank(treasury);
        registry.registerFor(string(upper), other, other);

        assertEq(registry.resolve(string(lower)), wallet);
        assertEq(registry.resolve(string(upper)), other);
    }

    /// The regression guard for canonical-name squatting (ruled),
    /// and the reason it is caller-varying rather than a single example: the
    /// attack is that ANY address can take a name, and a name is a unique
    /// resource. A canonical id is derivable from an org label and a local id
    /// before that agent exists, so before this modifier a stranger could own
    /// `orch:victim` and have every payment to that name resolve to them.
    function testFuzz_OnlyRegistrarCanRegister(address caller) public {
        NameRegistry registry = new NameRegistry(treasury);
        vm.assume(caller != treasury);

        vm.prank(caller);
        vm.expectRevert();
        registry.register("orch:victim", caller);

        assertEq(registry.resolve("orch:victim"), address(0), "a non-registrar took a canonical name");

        // And the name is still free for its rightful spawn.
        vm.prank(treasury);
        registry.registerFor("orch:victim", wallet, wallet);
        assertEq(registry.resolve("orch:victim"), wallet);
    }

    /// No caller without REGISTRAR_ROLE may register on someone else's behalf,
    /// for any address the fuzzer can produce.
    function testFuzz_OnlyRegistrarCanRegisterForOthers(address caller) public {
        NameRegistry registry = new NameRegistry(treasury);
        vm.assume(caller != treasury);

        vm.prank(caller);
        vm.expectRevert();
        registry.registerFor("someone.play", wallet, wallet);
    }
}
