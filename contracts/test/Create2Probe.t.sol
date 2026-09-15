// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Script} from "forge-std/Script.sol";
import {Token} from "../src/Token.sol";

/// WHICH ADDRESS DEPLOYS A SALTED `new`. Two builders measured this
/// independently and got different answers; both measurements were correct,
/// because THE ANSWER DEPENDS ON THE SHAPE OF THE CALL.
///
/// FOUR CASES, AND THE HEADER USED TO NAME A FIFTH IT DID NOT TEST. It said
/// "the one that governs Deploy.s.sol is the third", and the third is a
/// creation with no broadcast at all - which is not the deploy script's shape
/// and does not route through the canonical deployer. Three assertions checked
/// three things; the sentence above them described a fourth. That fourth case
/// is now `test_InsideAScriptUnderBroadcast`, measured rather than asserted
/// from the header, and it is the one that governs Deploy.s.sol and the
/// manifest cache's address re-derivation.
///
///   broadcast, creation in the same TEST frame   -> the BROADCASTER
///   broadcast, creation one frame down           -> the ENCLOSING CONTRACT
///   no broadcast                                 -> `address(this)`
///   broadcast inside a SCRIPT-derived contract   -> the CANONICAL DEPLOYER
///
/// The last is why `Deploy.s.sol` produces the same addresses under `forge
/// test` and `forge script --broadcast`, and why the cache re-derives against
/// 0x4e59b448... rather than against the treasury.
/// A salted `new` performed inside a SEPARATE contract, which is the shape the
/// real deploy script has: the test calls a method on another contract, and the
/// creation happens there while a broadcast is active.
contract Maker {
    function make(bytes32 salt, string memory n, address admin) external returns (address) {
        return address(new Token{salt: salt}(n, n, admin));
    }
}

/// A Script, not a Test: the distinction is the whole finding. `vm.startBroadcast`
/// inside a contract deriving from `Script` routes a same-frame salted `new`
/// through the canonical CREATE2 deployer.
contract ScriptMaker is Script {
    function make(bytes32 salt, string memory n, address admin) external returns (address) {
        vm.startBroadcast(uint256(0xA11CE));
        address t = address(new Token{salt: salt}(n, n, admin));
        vm.stopBroadcast();
        return t;
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

    /// THE CASE THAT GOVERNS Deploy.s.sol, and the one the header used to
    /// describe without testing. A broadcast started inside a SCRIPT-derived
    /// contract, with the creation in that same frame, routes through the
    /// canonical CREATE2 deployer - not through the broadcaster, which is what
    /// the same shape gives inside a Test contract.
    ///
    /// Measured: deploying token-and-names through Deploy and re-deriving the
    /// token's address gave the canonical deployer's answer and neither the
    /// broadcaster's nor the script's.
    function test_InsideAScriptUnderBroadcast() public {
        ScriptMaker m = new ScriptMaker();
        address t = m.make(keccak256("probe-d"), "N", treasury);

        emit log_named_address("deployed", t);
        emit log_named_address("canonical", vm.computeCreate2Address(keccak256("probe-d"), _initHash(), CANONICAL));
        emit log_named_address("broadcaster", vm.computeCreate2Address(keccak256("probe-d"), _initHash(), vm.addr(uint256(0xA11CE))));
        assertEq(t, vm.computeCreate2Address(keccak256("probe-d"), _initHash(), CANONICAL));
    }

    function test_WithNoBroadcast() public {
        Token t = new Token{salt: keccak256("probe-b")}("N", "N", treasury);

        emit log_named_address("deployed", address(t));
        emit log_named_address("canonical", vm.computeCreate2Address(keccak256("probe-b"), _initHash(), CANONICAL));
        emit log_named_address("this", vm.computeCreate2Address(keccak256("probe-b"), _initHash(), address(this)));
        assertEq(address(t), vm.computeCreate2Address(keccak256("probe-b"), _initHash(), address(this)));
    }
}
