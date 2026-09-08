// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title VEE Bux - the in-game currency of Operation PowerOUT.
/// @notice ERC-20, 18 decimals, symbol VEE. Minting is the treasury's alone:
/// the deploy script seeds INITIAL_SUPPLY and the facilitator API tops up
/// mid-game, both through MINTER_ROLE.
/// @dev Deliberately has no pause, no burn and no blacklist (spec S3.1).
/// Freezing a wallet is a POLICY-layer action in chain-svc / wallet-mcp, not a
/// contract action - so do not add a freeze here when someone asks for one;
/// the answer is `DELETE /wallets/:agentId`, which never touches this token.
contract VEEBux is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    error ZeroAddress();

    /// @param admin receives DEFAULT_ADMIN_ROLE and MINTER_ROLE. In the game
    /// this is the treasury key held only by chain-svc (spec S2).
    constructor(address admin) ERC20("VEE Bux", "VEE") {
        // A token deployed with no admin can never mint: no treasury, no
        // supply, and no way to grant the role afterwards.
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
