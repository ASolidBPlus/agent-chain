// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice The mint/burn surface the Converter needs from a Token. Declared here
/// rather than imported so the Converter compiles and deploys against any
/// Token-shaped contract; the deploy grants it the roles these calls require.
interface IMintBurnToken {
    function mint(address to, uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
}

/// @title Converter - the single bridge between two Tokens on the chain.
/// @notice Turns an amount of one Token into an amount of another at a rate the
/// rate admin sets, by burning the source and minting the target. The money
/// rules that make a two-currency economy safe live here: no pair exists unless
/// the admin created it, no loop can mint value from nothing, every rate change
/// and every conversion is an event, and either direction is pausable.
/// @dev No allowances of any kind: `convert` acts on `msg.sender`'s own balance
/// only, never on behalf of another account. The two external calls are to
/// Token contracts and state is read before them and never written after, so
/// there is no reentrancy surface; order is burn-then-mint so a failed mint
/// reverts the burn and nothing is minted.
contract Converter is AccessControl {
    /// Sets rates and pauses; granted to the admin at construction.
    bytes32 public constant RATE_ADMIN_ROLE = keccak256("RATE_ADMIN_ROLE");

    /// Rates are fixed-point with 18 places: `rate` is target units per 1 source
    /// unit, scaled by RATE_SCALE.
    uint256 public constant RATE_SCALE = 1e18;

    /// 1e12 target units per source unit. Keeps rate*rate and amountIn*rate far
    /// from uint256 overflow: checked arithmetic would Panic(0x11) near 3.4e38
    /// with a raw panic instead of a named error.
    uint256 public constant MAX_RATE = 1e30;

    struct Pair {
        uint256 rate; // target units per 1 source unit, RATE_SCALE-scaled
        bool paused;
        bool exists;
    }

    mapping(address => mapping(address => Pair)) private pairs; // pairs[source][target]

    error ZeroAddress();
    error SameToken();
    error UnknownPair(address source, address target);
    error PairPaused(address source, address target);
    error ZeroAmount();
    error ZeroRate();
    error RateTooHigh(uint256 rate);
    error LoopMintsValue(address a, address b, uint256 rateAB, uint256 rateBA);
    error NothingMinted(uint256 amountIn, uint256 rate);

    event PairSet(
        address indexed source, address indexed target, uint256 rate, uint256 previousRate, address indexed by
    );
    event PairPausedSet(address indexed source, address indexed target, bool paused, address indexed by);
    event Converted(
        address indexed account,
        address indexed source,
        address indexed target,
        uint256 amountIn,
        uint256 amountOut,
        uint256 rate,
        bytes32 intentId
    );

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RATE_ADMIN_ROLE, admin);
    }

    /// @notice Create or update the rate for converting `source` into `target`.
    /// @dev Loop guard: if the reverse pair exists, the product of the two rates
    /// must not exceed 1 (in RATE_SCALE^2 fixed point), so a round trip can never
    /// mint value. `paused` is left unchanged on update and starts false on
    /// creation.
    function setPair(address source, address target, uint256 rate) external onlyRole(RATE_ADMIN_ROLE) {
        if (source == target) revert SameToken();
        if (source == address(0) || target == address(0)) revert ZeroAddress();
        if (rate == 0) revert ZeroRate();
        if (rate > MAX_RATE) revert RateTooHigh(rate);

        Pair storage reversePair = pairs[target][source];
        if (reversePair.exists) {
            // rate (source->target) * reverse rate (target->source) <= 1.
            // Both are <= MAX_RATE = 1e30, so the product is <= 1e60, far below
            // the uint256 ceiling: this multiply cannot overflow.
            if (rate * reversePair.rate > RATE_SCALE * RATE_SCALE) {
                revert LoopMintsValue(source, target, rate, reversePair.rate);
            }
        }

        Pair storage p = pairs[source][target];
        uint256 previousRate = p.rate;
        if (!p.exists) {
            p.exists = true;
            p.paused = false;
        }
        p.rate = rate;

        emit PairSet(source, target, rate, previousRate, msg.sender);
    }

    /// @notice Pause or unpause conversions for an existing pair.
    function setPaused(address source, address target, bool paused) external onlyRole(RATE_ADMIN_ROLE) {
        Pair storage p = pairs[source][target];
        if (!p.exists) revert UnknownPair(source, target);
        p.paused = paused;
        emit PairPausedSet(source, target, paused, msg.sender);
    }

    /// @notice Read a pair's rate, pause flag and existence.
    function pair(address source, address target) external view returns (uint256 rate, bool paused, bool exists) {
        Pair storage p = pairs[source][target];
        return (p.rate, p.paused, p.exists);
    }

    /// @notice Target units returned for `amountIn` source units, floored.
    /// @dev Information, not a conversion: does not check pause.
    function quote(address source, address target, uint256 amountIn) public view returns (uint256 amountOut) {
        Pair storage p = pairs[source][target];
        if (!p.exists) revert UnknownPair(source, target);
        return amountIn * p.rate / RATE_SCALE;
    }

    /// @notice Convert `amountIn` of `source` held by the caller into `target`,
    /// burning the source and minting the target to the caller.
    /// @dev The sub-unit remainder `amountIn * rate % RATE_SCALE` is burned with
    /// the source and never minted. `intentId` is opaque and only echoed in the
    /// event.
    function convert(address source, address target, uint256 amountIn, bytes32 intentId)
        external
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        Pair storage p = pairs[source][target];
        if (!p.exists) revert UnknownPair(source, target);
        if (p.paused) revert PairPaused(source, target);

        uint256 rate = p.rate;
        amountOut = amountIn * rate / RATE_SCALE; // identical to quote(source, target, amountIn)
        if (amountOut == 0) revert NothingMinted(amountIn, rate);

        // burn-then-mint: a failed mint reverts the burn, so nothing is minted.
        IMintBurnToken(source).burnFrom(msg.sender, amountIn);
        IMintBurnToken(target).mint(msg.sender, amountOut);

        emit Converted(msg.sender, source, target, amountIn, amountOut, rate, intentId);
    }
}
