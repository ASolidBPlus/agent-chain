// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IEscrowHook} from "./IEscrowHook.sol";
import {NameRegistry} from "./NameRegistry.sol";

/// @title JudgeHook - a completion counts when a named judging wallet reports it.
/// @notice hookData is packed: byte 0 is the mode, the rest is the backend name.
/// Mode 0 accepts `<creator>:<backend>` only; mode 1 accepts `<winner>:<backend>`.
/// @dev Stateless apart from the registry address, which is in storage because
/// the ABI generator refuses immutables.
contract JudgeHook is IEscrowHook {
    uint8 internal constant ONE_JUDGE = 0;
    uint8 internal constant EACH_OWN_COPY = 1;

    NameRegistry public registry;

    constructor(address names) {
        registry = NameRegistry(names);
    }

    function check(bytes calldata hookData, string calldata creatorAlias, string calldata winnerAlias, address sender)
        external
        view
        returns (bool)
    {
        if (hookData.length < 2) return false;
        uint8 mode = uint8(hookData[0]);
        string memory backend = string(hookData[1:]);
        if (mode == ONE_JUDGE) return sender == registry.resolve(string.concat(creatorAlias, ":", backend));
        if (mode == EACH_OWN_COPY) return sender == registry.resolve(string.concat(winnerAlias, ":", backend));
        return false;
    }
}
