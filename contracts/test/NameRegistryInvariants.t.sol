// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {NameRegistry} from "../src/NameRegistry.sol";

/// Drives the registry through random sequences of the operations chain-svc
/// actually performs. Every action is GUARDED so it cannot revert: with
/// fail_on_revert = true, a revert here means the handler's model of what is
/// legal has drifted from the contract's, which is itself worth knowing.
contract RegistryHandler is Test {
    NameRegistry public registry;
    address public immutable treasury;

    address[] public wallets;
    string[] public names;

    /// Must stay zero: registering a name for a wallet that already has a
    /// primary name must never change that name (spec S3.2). Counted rather
    /// than asserted inline so a failure reports how often, not just that.
    uint256 public reverseOverwrites;

    /// Must stay zero: setTargetFor on an unregistered name must revert rather
    /// than create a record owned by address(0) that resolve() would then serve.
    uint256 public phantomRecords;

    /// Must stay zero: a registration naming address(0) as owner would leave a
    /// record that reads unregistered to every check here while still holding
    /// reverse[target].
    uint256 public zeroOwnerRecords;

    /// Must stay zero: transfer(name, address(0)) is a silent RELEASE, not a
    /// burn - the record survives and resolves while reading as unowned.
    uint256 public zeroReleases;

    /// Must stay zero: `register` makes the CALLER the owner, whatever target
    /// they point the name at.
    uint256 public ownerIsNotTheCaller;

    /// Must stay zero: `register` is FORWARD-ONLY and must never write a
    /// primary name for the address it points at.
    uint256 public foreignRegisterWroteReverse;

    /// Must stay zero: `register` is REGISTRAR-ONLY (ruled 22:20 UTC), so a
    /// non-registrar taking a name is the squat that made canonical ids
    /// stealable.
    uint256 public strangerTookAName;

    constructor(NameRegistry registry_, address treasury_) {
        registry = registry_;
        treasury = treasury_;
        for (uint256 i = 0; i < 5; i++) {
            wallets.push(address(uint160(0x1000 + i)));
        }
        names.push("orch:alpha");
        names.push("orch:bravo");
        names.push("alpha.vee");
        names.push("bravo.vee");
        names.push("aIpha.vee");
        names.push("charlie.vee");
    }

    function _wallet(uint256 seed) internal view returns (address) {
        return wallets[seed % wallets.length];
    }

    function _name(uint256 seed) internal view returns (string memory) {
        return names[seed % names.length];
    }

    function _taken(string memory name) internal view returns (bool) {
        (address owner,) = registry.records(keccak256(bytes(name)));
        return owner != address(0);
    }

    function _ownerOf(string memory name) internal view returns (address owner) {
        (owner,) = registry.records(keccak256(bytes(name)));
    }

    /// chain-svc registering a name at spawn, or an alias after a purchase.
    function register(uint256 nameSeed, uint256 walletSeed) public {
        string memory name = _name(nameSeed);
        if (_taken(name)) return;
        address wallet = _wallet(walletSeed);

        string memory before = registry.reverseOf(wallet);

        vm.prank(treasury);
        registry.registerFor(name, wallet, wallet);

        string memory current = registry.reverseOf(wallet);
        if (bytes(before).length != 0 && keccak256(bytes(before)) != keccak256(bytes(current))) {
            reverseOverwrites++;
        }
    }

    /// Retirement clearing an alias target, or a repoint.
    function repoint(uint256 nameSeed, uint256 walletSeed) public {
        string memory name = _name(nameSeed);
        if (!_taken(name)) return;

        vm.prank(treasury);
        registry.setTargetFor(name, _wallet(walletSeed));
    }

    /// A name changing hands - in game, a darknet purchase.
    function handOver(uint256 nameSeed, uint256 walletSeed) public {
        string memory name = _name(nameSeed);
        if (!_taken(name)) return;

        address owner = _ownerOf(name);
        vm.prank(owner);
        registry.transfer(name, _wallet(walletSeed));
    }

    /// Deliberately UNGUARDED, unlike the actions above: setTargetFor on a name
    /// nobody registered is exactly the phantom-record case UnknownName exists
    /// to refuse, and a handler that guards it away makes the invariant unable
    /// to see the bug. Found by mutation - with the guard removed from
    /// setTargetFor, every invariant still passed, because no action ever
    /// reached it.
    ///
    /// try/catch rather than a bare call so fail_on_revert stays meaningful:
    /// the revert is the CORRECT behaviour here, and succeeding is the finding.
    function repointUnregistered(uint256 nameSeed, uint256 walletSeed) public {
        string memory name = string(abi.encodePacked("ghost", vm.toString(nameSeed % 32), ".vee"));
        if (_taken(name)) return;

        vm.prank(treasury);
        try registry.setTargetFor(name, _wallet(walletSeed)) {
            phantomRecords++;
        } catch {
            // UnknownName: what should happen.
        }
    }

    /// UNGUARDED, like repointUnregistered and for the same reason. The
    /// invariant that no resolvable name lacks an owner was CORRECT and
    /// UNREACHABLE before this: the actor pool never contains address(0), so
    /// nothing ever attempted a zero-owner registration and the invariant could
    /// not have failed however broken the contract was. Found by sec-reviewer-2
    /// reading the handler - the same defect I had already found one function
    /// over, on setTargetFor, and did not generalise.
    function registerZeroOwner(uint256 nameSeed, uint256 walletSeed) public {
        string memory name = string(abi.encodePacked("zero", vm.toString(nameSeed % 32), ".vee"));
        if (_taken(name)) return;

        vm.prank(treasury);
        try registry.registerFor(name, address(0), _wallet(walletSeed)) {
            zeroOwnerRecords++;
        } catch {
            // ZeroAddress: what should happen.
        }
    }

    /// UNGUARDED: transfer to address(0) must revert rather than release.
    function transferToZero(uint256 nameSeed) public {
        string memory name = _name(nameSeed);
        if (!_taken(name)) return;

        vm.prank(_ownerOf(name));
        try registry.transfer(name, address(0)) {
            zeroReleases++;
        } catch {
            // ZeroAddress: what should happen.
        }
    }

    /// `register` with a target that is NOT the caller - never driven anywhere
    /// before build-triage asked. Seat 2's mutant `_register(name, target,
    /// target)` survives any suite that always passes target == msg.sender.
    ///
    /// The caller is the TREASURY, because register is registrar-only now; a
    /// wallet caller would revert every time and the assertions below would
    /// never run. The stranger case has its own action rather than being
    /// folded in here - two behaviours in one action tests neither.
    function registerForeignTarget(uint256 nameSeed, uint256 targetSeed) public {
        string memory name = string(abi.encodePacked("foreign", vm.toString(nameSeed % 32), ".vee"));
        if (_taken(name)) return;

        address target = _wallet(targetSeed);
        string memory reverseBefore = registry.reverseOf(target);

        vm.prank(treasury);
        registry.register(name, target);

        if (_ownerOf(name) != treasury) ownerIsNotTheCaller++;
        if (keccak256(bytes(registry.reverseOf(target))) != keccak256(bytes(reverseBefore))) {
            foreignRegisterWroteReverse++;
        }
    }

    /// UNGUARDED: a non-registrar taking a name must revert. Counted rather
    /// than swallowed, so removing the modifier is visible here and not only in
    /// the example tests.
    function strangerRegisters(uint256 nameSeed, uint256 callerSeed) public {
        string memory name = string(abi.encodePacked("squat", vm.toString(nameSeed % 32), ".vee"));
        if (_taken(name)) return;

        vm.prank(_wallet(callerSeed));
        try registry.register(name, _wallet(callerSeed)) {
            strangerTookAName++;
        } catch {
            // AccessControl: what should happen.
        }
    }

    function walletCount() external view returns (uint256) {
        return wallets.length;
    }
}

/// @title Invariants that must hold however chain-svc drives the registry.
contract NameRegistryInvariantsTest is Test {
    NameRegistry internal registry;
    RegistryHandler internal handler;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        registry = new NameRegistry(treasury);
        handler = new RegistryHandler(registry, treasury);
        targetContract(address(handler));
    }

    /// The one that matters for money: if an address has a primary name, that
    /// name resolves back to it. A wallet whose reverse pointed at a name
    /// resolving elsewhere would make /reverse and /resolve disagree about who
    /// owns an address - and chain-svc reports both to the game.
    function invariant_reverseAlwaysResolvesBackToItsOwnAddress() public view {
        uint256 count = handler.walletCount();
        for (uint256 i = 0; i < count; i++) {
            address wallet = handler.wallets(i);
            string memory name = registry.reverseOf(wallet);
            if (bytes(name).length == 0) continue;
            assertEq(registry.resolve(name), wallet, "reverseOf pointed at a name that resolves elsewhere");
        }
    }

    /// A wallet's canonical name is the one it was spawned with. Buying vanity
    /// aliases must never change it - that is what makes the canonical id a
    /// stable key for money rather than whatever was registered most recently.
    function invariant_registeringNeverOverwritesAnExistingPrimaryName() public view {
        assertEq(handler.reverseOverwrites(), 0, "a registration changed an existing primary name");
    }

    /// A name that resolves to a non-zero address always has an owner: there is
    /// no path that produces a targeted-but-unowned record. This is what
    /// setTargetFor's UnknownName check exists to prevent.
    function invariant_everyResolvableNameHasAnOwner() public view {
        for (uint256 i = 0; i < 6; i++) {
            string memory name = handler.names(i);
            if (registry.resolve(name) == address(0)) continue;
            (address owner,) = registry.records(keccak256(bytes(name)));
            assertTrue(owner != address(0), "a resolvable name has no owner");
        }
        // The direct statement of the same property, reachable only because
        // repointUnregistered is unguarded: if setTargetFor ever succeeded on a
        // name nobody registered, this is what would have counted it.
        assertEq(handler.phantomRecords(), 0, "setTargetFor created a record for an unregistered name");
        assertEq(handler.zeroOwnerRecords(), 0, "a registration named address(0) as owner");
    }

    /// A name must never become unowned while still resolving: that is what
    /// makes it re-registerable by a stranger who then inherits whatever the
    /// original target's primary name pointed at.
    function invariant_ANameIsNeverReleasedByTransferringItToZero() public view {
        assertEq(handler.zeroReleases(), 0, "transfer(name, address(0)) released a name instead of reverting");
    }

    /// Whoever calls the permissionless register() owns the result, whatever
    /// address they point it at.
    function invariant_RegisterAlwaysMakesTheCallerTheOwner() public view {
        assertEq(handler.ownerIsNotTheCaller(), 0, "register() made someone other than the caller the owner");
    }

    /// The permissionless path is forward-only: it may make a name resolve and
    /// must never set or change anyone's primary name.
    function invariant_RegisterNeverWritesAPrimaryName() public view {
        assertEq(handler.foreignRegisterWroteReverse(), 0, "register() wrote a primary name for its target");
    }

    /// Canonical ids are publicly derivable before their agent exists, so a
    /// name any stranger can take is a name any stranger can be paid for.
    function invariant_OnlyTheRegistrarCanTakeAName() public view {
        assertEq(handler.strangerTookAName(), 0, "a non-registrar registered a name");
    }
}
