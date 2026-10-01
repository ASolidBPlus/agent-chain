// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IEscrowHook} from "./IEscrowHook.sol";
import {NameRegistry} from "./NameRegistry.sol";
import {Token} from "./Token.sol";

/// @title Escrow - first-to-complete bounties held out of supply.
/// @notice A creator's treasury locks an amount by burning it. The first completion
/// the hook accepts mints it to the winner's treasury; after the deadline anyone
/// can refund it to the creator. Each escrow settles once.
/// @dev Holds BURNER_ROLE and MINTER_ROLE on the tokens it serves and no admin role.
/// State is written before every mint.
contract Escrow {
    bytes32 internal constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 internal constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint8 internal constant NONE = 0;
    uint8 internal constant OPEN = 1;
    uint8 internal constant COMPLETED = 2;
    uint8 internal constant REFUNDED = 3;

    struct Record {
        string creatorAlias;
        address creator;
        address token;
        uint256 amount;
        address hook;
        bytes hookData;
        uint64 deadline;
        uint8 state;
        string winnerAlias;
    }

    /// In storage rather than immutable: the ABI generator refuses immutables.
    NameRegistry public registry;

    mapping(bytes32 => Record) internal records;

    error Exists();
    error ZeroAmount();
    error BadDeadline();
    error NotCreator();
    error BadHook();
    error UnknownToken();
    error NotOpen();
    error TooLate();
    error HookRefused();
    error UnknownWinner();
    error NotYet();

    event Created(bytes32 indexed id, string creatorAlias, address token, uint256 amount, address hook, uint64 deadline);
    event Completed(bytes32 indexed id, string winnerAlias, uint256 amount);
    event Refunded(bytes32 indexed id, string creatorAlias, uint256 amount);

    constructor(address names) {
        registry = NameRegistry(names);
    }

    /// @notice Lock `amount` of `token` from the caller, who must be `creatorAlias`'s treasury.
    function create(
        bytes32 id,
        string calldata creatorAlias,
        address token,
        uint256 amount,
        address hook,
        bytes calldata hookData,
        uint64 deadline
    ) external {
        if (records[id].state != NONE) revert Exists();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert BadDeadline();
        if (registry.resolve(string.concat(creatorAlias, ":treasury")) != msg.sender) revert NotCreator();
        if (hook.code.length == 0) revert BadHook();
        if (!_serves(token)) revert UnknownToken();

        Record storage r = records[id];
        r.creatorAlias = creatorAlias;
        r.creator = msg.sender;
        r.token = token;
        r.amount = amount;
        r.hook = hook;
        r.hookData = hookData;
        r.deadline = deadline;
        r.state = OPEN;

        Token(token).burnFrom(msg.sender, amount);
        emit Created(id, creatorAlias, token, amount, hook, deadline);
    }

    /// @notice Pay `winnerAlias`'s treasury, if the hook accepts this report and it is the first.
    function complete(bytes32 id, string calldata winnerAlias) external {
        Record storage r = records[id];
        if (r.state != OPEN) revert NotOpen();
        if (block.timestamp > r.deadline) revert TooLate();
        if (!IEscrowHook(r.hook).check(r.hookData, r.creatorAlias, winnerAlias, msg.sender)) revert HookRefused();
        address winner = registry.resolve(string.concat(winnerAlias, ":treasury"));
        if (winner == address(0)) revert UnknownWinner();

        r.state = COMPLETED;
        r.winnerAlias = winnerAlias;

        Token(r.token).mint(winner, r.amount);
        emit Completed(id, winnerAlias, r.amount);
    }

    /// @notice Return an expired escrow to its creator. Anyone may call it.
    function refund(bytes32 id) external {
        Record storage r = records[id];
        if (r.state != OPEN) revert NotOpen();
        if (block.timestamp <= r.deadline) revert NotYet();

        r.state = REFUNDED;

        Token(r.token).mint(r.creator, r.amount);
        emit Refunded(id, r.creatorAlias, r.amount);
    }

    /// @notice Everything stored for `id`, and the chain's current time.
    /// @dev state: 0 none, 1 open, 2 completed, 3 refunded.
    function get(bytes32 id)
        external
        view
        returns (
            string memory creatorAlias,
            address creator,
            address token,
            uint256 amount,
            address hook,
            bytes memory hookData,
            uint64 deadline,
            uint8 state,
            string memory winnerAlias,
            uint64 now
        )
    {
        Record storage r = records[id];
        return (
            r.creatorAlias,
            r.creator,
            r.token,
            r.amount,
            r.hook,
            r.hookData,
            r.deadline,
            r.state,
            r.winnerAlias,
            uint64(block.timestamp)
        );
    }

    /// True when `token` has granted this escrow both roles it needs. The code
    /// check comes first: try/catch cannot catch a call to an address with no code.
    function _serves(address token) internal view returns (bool) {
        if (token.code.length == 0) return false;
        try IAccessControl(token).hasRole(BURNER_ROLE, address(this)) returns (bool burner) {
            if (!burner) return false;
        } catch {
            return false;
        }
        try IAccessControl(token).hasRole(MINTER_ROLE, address(this)) returns (bool minter) {
            return minter;
        } catch {
            return false;
        }
    }
}
