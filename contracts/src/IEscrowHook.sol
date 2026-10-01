// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Decides whether a completion report counts. Escrow calls it as a view,
/// so a hook can read but never change state.
interface IEscrowHook {
    function check(bytes calldata hookData, string calldata creatorAlias, string calldata winnerAlias, address sender)
        external
        view
        returns (bool);
}
