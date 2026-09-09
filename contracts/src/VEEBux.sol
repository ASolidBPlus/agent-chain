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

    /// Emitted ALONGSIDE the standard ERC-20 `Transfer`, never instead of it -
    /// so anything reading `Transfer` is unaffected by this existing.
    event IntentTransfer(
        bytes32 indexed intentId,
        address indexed from,
        address indexed to,
        uint256 amount
    );

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

    /// @notice A transfer that also records WHICH INTENT authorised it.
    /// @dev Authorisation is the STANDARD transfer path and nothing else: this
    /// calls `transfer`, so the mover is always `msg.sender`. There is
    /// deliberately no `from` parameter and no allowance path - this function
    /// can never move anyone else's money, and adding either would make it a
    /// second, weaker `transferFrom`.
    ///
    /// @param intentId keccak256(bytes(<the caller's intent id string>)). ONE
    /// derivation, used identically when chain-svc reserves the intent, when it
    /// calls this, and when the sweep scans for it - three derivations would
    /// give three answers to "did this land?".
    ///
    /// THIS CONTRACT DOES NOT DEDUPLICATE, and that is the design rather than an
    /// omission. Two calls with the same intentId both succeed and both emit.
    /// The dedupe is chain-svc's reservation, taken before the broadcast; this
    /// event is a RECORD, not a uniqueness constraint. Three reasons, in the
    /// order they matter:
    ///
    /// 1. On-chain uniqueness would SUPPRESS THE ANOMALY IT APPEARS TO PREVENT.
    ///    Two events for one intentId means something bypassed the reservation -
    ///    in practice a second chain-svc with its own store writing to this
    ///    chain, since reservation uniqueness is scoped to one database and not
    ///    to the chain. With no on-chain dedupe both transfers land, both emit,
    ///    and the sweep raises `chain.anomaly` with a facilitator looking at it.
    ///    With dedupe the second reverts, chain-svc reports an ordinary chain
    ///    error, and nobody ever learns a second store is writing here. It
    ///    cannot prevent the second store existing; it can only stop recording
    ///    it. A record that refuses to record the anomalous case is worse than
    ///    useless for reconciliation.
    /// 2. It is redundant with the reservation, which already refuses a
    ///    same-id retry before anything is broadcast.
    /// 3. It would cost a permanent storage slot per intent, for ever.
    ///
    /// SO: THE PRESENCE OF THIS EVENT PROVES A TRANSFER HAPPENED, NEVER THAT IT
    /// HAPPENED ONCE. Reading it as an idempotency guarantee is wrong.
    function transferWithIntent(address to, uint256 amount, bytes32 intentId) external returns (bool) {
        bool ok = transfer(to, amount);
        emit IntentTransfer(intentId, msg.sender, to, amount);
        return ok;
    }
}
