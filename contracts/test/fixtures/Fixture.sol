// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// A minimal contract with a static-typed constructor, for exercising the
/// manifest `contract` kind end to end in Deploy.t.sol (Chain Call §8.8). It is
/// deployed by name from the manifest, so it lives under test/fixtures rather
/// than src - it is never part of a real deployment.
contract Fixture {
    address public immutable token;
    uint256 public immutable n;
    bool public immutable flag;
    bytes32 public immutable tag;

    constructor(address token_, uint256 n_, bool flag_, bytes32 tag_) {
        token = token_;
        n = n_;
        flag = flag_;
        tag = tag_;
    }
}
