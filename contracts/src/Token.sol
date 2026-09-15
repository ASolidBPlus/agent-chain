// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Token - one instance of the chain's generic ERC-20.
/// @notice ERC-20, 18 decimals, name and symbol given at deploy. A deployment
/// may carry several instances; each is this contract with different
/// constructor arguments. Minting is the treasury's alone: the deploy script
/// seeds the manifest's initialSupply and the facilitator API tops up
/// mid-game, both through MINTER_ROLE.
/// @dev No pause and no blacklist. There IS a per-account SEND FREEZE, and
/// this block used to forbid one in as many words - "freezing a wallet is a
/// POLICY-layer action in chain-svc, not a contract action; do not add a freeze
/// here when someone asks for one". The owner reversed that: a send freeze is a
/// contract primitive, operated by admin-call, with no chain-svc coupling.
///
/// The reversal's reason, not just its fact: a policy-layer lock holds only
/// while every spend goes through the service. A leaked wallet key or a
/// contract-to-contract spend bypasses it entirely, and those are the two cases
/// a freeze is for. THIS bar holds regardless, because it is the token's own.
///
/// No exceptions and no coupling: the contract does not ask any service what it
/// thinks, and nothing outside it can make a frozen account send. Operated by
/// admin-call, like any other role-gated function here.
///
/// Deliberately says nothing about what any service does. An earlier draft of
/// this block named a service route as the other half of the story; the route
/// did not exist, and a header that invents an endpoint sends a reader looking
/// for one. What a service does with freezing is that service's to document and
/// its to change.
///
/// The old text is quoted rather than deleted because a reader who meets a
/// `frozen` mapping in a contract whose header denies having one cannot tell
/// which is stale. A contract whose doc block contradicts its code is a defect,
/// and this file shipped as one for exactly as long as it took to read it.
contract Token is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Burning is a role nobody holds at deploy.
    /// @dev Granted to no address by the constructor and to none by the deploy
    /// script, which asserts exactly that. It exists so a converter contract
    /// can be granted it later without a redeploy; until someone is granted it,
    /// `burnFrom` is unreachable and this contract behaves as it did before the
    /// role existed. A role with no holder changes no behaviour.
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /// @notice May freeze and unfreeze any account's ability to SEND.
    /// @dev Granted to `admin` in the constructor, beside MINTER_ROLE - not by
    /// the deploy script, which only ASSERTS it. A role granted where the
    /// contract is constructed cannot be forgotten by a deployment that skips a
    /// script step.
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");

    error ZeroAddress();

    /// @notice This account cannot send while frozen.
    /// @dev Carries the account so an operator reading a reverted transaction
    /// knows WHICH party was frozen - in a `transferFrom` the frozen party is
    /// not the caller.
    error AccountFrozen(address account);

    /// @notice Whether `account` is barred from sending.
    /// @dev Public, so the getter `frozen(address)` is the read a persona and an
    /// operator both use; no separate view function.
    mapping(address => bool) public frozen;

    /// @notice Emitted on EVERY `setFrozen` call, including one that changes
    /// nothing.
    /// @dev A no-op still emits, deliberately: the feed is a record of what the
    /// OPERATOR DID, and "froze an already-frozen account" is an action someone
    /// took. A state-change-only event would make the feed a record of the
    /// state's history instead, which the mapping already is.
    event Frozen(address indexed account, bool value);

    /// Emitted ALONGSIDE the standard ERC-20 `Transfer`, never instead of it -
    /// so anything reading `Transfer` is unaffected by this existing.
    event IntentTransfer(
        bytes32 indexed intentId,
        address indexed from,
        address indexed to,
        uint256 amount
    );

    /// @param name_ the token's ERC-20 name, from the deployment manifest.
    /// @param symbol_ the token's ERC-20 symbol, from the deployment manifest.
    /// @param admin receives DEFAULT_ADMIN_ROLE and MINTER_ROLE - and NOT
    /// BURNER_ROLE, deliberately. In the game this is the treasury key held
    /// only by chain-svc (spec S2).
    constructor(string memory name_, string memory symbol_, address admin) ERC20(name_, symbol_) {
        // A token deployed with no admin can never mint: no treasury, no
        // supply, and no way to grant the role afterwards.
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(FREEZER_ROLE, admin);
    }

    /// @notice Bar `account` from sending, or lift the bar. FREEZER_ROLE only.
    /// @dev Idempotent, and emits either way - see the event.
    function setFrozen(address account, bool value) external onlyRole(FREEZER_ROLE) {
        frozen[account] = value;
        emit Frozen(account, value);
    }

    /// @dev THE ONE ENFORCEMENT POINT. Every movement in an OpenZeppelin v5
    /// ERC-20 goes through `_update`, so overriding it here covers `transfer`,
    /// `transferFrom`, `transferWithIntent` and a Converter's `burnFrom` in one
    /// place - four paths that would otherwise need four checks, and a fifth
    /// added later would need a fifth.
    ///
    /// `from != address(0)` is the mint exemption, and it is deliberate: minting
    /// TO a frozen account succeeds, because a freeze bars SENDING and nothing
    /// else. Receiving is unaffected for the same reason - a frozen account is
    /// still a valid destination, and an operator topping one up is not a spend
    /// by it.
    ///
    /// A BURN IS A SPEND. `burnFrom` reaches here with `from` set and `to` zero,
    /// so a Converter cannot take a frozen account's tokens out of supply - which
    /// is the point: a conversion moves money, and routing round the freeze
    /// through a contract that holds BURNER_ROLE would be the bypass this
    /// primitive exists to close.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && frozen[from]) revert AccountFrozen(from);
        super._update(from, to, value);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Destroy `amount` from `account`. BURNER_ROLE only.
    /// @dev No allowance path and no self-burn shortcut: the only way to reach
    /// this is to hold the role, which nothing does at deploy. It is here so a
    /// converter can take one token out of supply as it issues another, and the
    /// asymmetry with `mint` is deliberate - minting is the treasury's, burning
    /// is nobody's until a deployment says otherwise.
    function burnFrom(address account, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(account, amount);
    }

    /// @notice A transfer that also records WHICH INTENT authorised it.
    /// @dev Authorisation is the STANDARD transfer path and nothing else: this
    /// calls `transfer`, so the mover is always `msg.sender`. There is
    /// deliberately no `from` parameter and no allowance path - this function
    /// can never move anyone else's money, and adding either would make it a
    /// second, weaker `transferFrom`.
    ///
    /// @param intentId AN OPAQUE bytes32, chosen by the service at reservation
    /// and passed through unchanged. THE CONTRACT NEVER DERIVES IT, and this
    /// block used to state the derivation - `keccak256(bytes(<intent id>))` -
    /// which made a caller's scheme read as a contract guarantee. It is neither
    /// checked nor relied on here, so documenting it committed this file to a
    /// decision taken entirely on the other side of the wire, and a change to
    /// that scheme would have made the contract's own comment false with no
    /// line of Solidity to notice.
    ///
    /// What the contract DOES require is that one value identifies one
    /// reservation for everyone who looks - the reserver, the caller and the
    /// sweep - because three answers to "did this land?" is the failure the
    /// field exists to prevent. That is the service's invariant to keep; this
    /// contract only carries the value.
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
