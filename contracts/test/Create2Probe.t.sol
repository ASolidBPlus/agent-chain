// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";

/// WHICH ADDRESS DEPLOYS A SALTED `new` INSIDE `forge test`. Two builders
/// measured this independently and got different answers; both measurements
/// were correct, because THE ANSWER DEPENDS ON THE SHAPE OF THE CALL. This file
/// pins all three so the next person does not have to discover that.
///
/// The one that governs Deploy.s.sol is the third: a broadcast started inside a
/// Script-derived contract, with the creation in that same frame, routes through
/// the canonical CREATE2 deployer - which is what makes the address the same
/// here as under `forge script --broadcast`.
/// A salted `new` performed inside a SEPARATE contract, which is the shape the
/// real deploy script has: the test calls a method on another contract, and the
/// creation happens there while a broadcast is active.
contract Maker {
    function make(bytes32 salt, string memory n, address admin) external returns (address) {
        return address(new Token{salt: salt}(n, n, admin));
    }
}

contract Create2ProbeTest is Test {
    address internal constant CANONICAL = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal treasury = makeAddr("treasury");

    function _initHash() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(type(Token).creationCode, abi.encode("N", "N", treasury)));
    }

    function test_WithAnActiveBroadcast() public {
        vm.startBroadcast(uint256(0xA11CE));
        Token t = new Token{salt: keccak256("probe-a")}("N", "N", treasury);
        vm.stopBroadcast();

        emit log_named_address("deployed", address(t));
        emit log_named_address("canonical", vm.computeCreate2Address(keccak256("probe-a"), _initHash(), CANONICAL));
        emit log_named_address("this", vm.computeCreate2Address(keccak256("probe-a"), _initHash(), address(this)));
        // The BROADCASTER, not the canonical deployer and not this contract.
        assertEq(address(t), vm.computeCreate2Address(keccak256("probe-a"), _initHash(), vm.addr(uint256(0xA11CE))));
    }

    function test_InsideAnotherContractUnderBroadcast() public {
        Maker m = new Maker();
        vm.startBroadcast(uint256(0xA11CE));
        address t = m.make(keccak256("probe-c"), "N", treasury);
        vm.stopBroadcast();

        emit log_named_address("deployed", t);
        emit log_named_address("canonical", vm.computeCreate2Address(keccak256("probe-c"), _initHash(), CANONICAL));
        emit log_named_address("maker", vm.computeCreate2Address(keccak256("probe-c"), _initHash(), address(m)));
        // The ENCLOSING CONTRACT: a broadcast started in the caller's frame
        // does not reach a creation one frame down.
        assertEq(t, vm.computeCreate2Address(keccak256("probe-c"), _initHash(), address(m)));
    }

    function test_WithNoBroadcast() public {
        Token t = new Token{salt: keccak256("probe-b")}("N", "N", treasury);

        emit log_named_address("deployed", address(t));
        emit log_named_address("canonical", vm.computeCreate2Address(keccak256("probe-b"), _initHash(), CANONICAL));
        emit log_named_address("this", vm.computeCreate2Address(keccak256("probe-b"), _initHash(), address(this)));
        assertEq(address(t), vm.computeCreate2Address(keccak256("probe-b"), _initHash(), address(this)));
    }
}
