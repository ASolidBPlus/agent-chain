// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VEEBux} from "../src/VEEBux.sol";
import {NameRegistry} from "../src/NameRegistry.sol";

/// @title Deploy - brings up VEE Bux and the name registry on the private chain.
/// @notice Deploys both contracts from the treasury key, seeds the treasury with
/// INITIAL_SUPPLY, registers `treasury.vee`, and writes deployments/local.json.
/// @dev IDEMPOTENT BY DESIGN (spec S3.3): compose runs this on every start, so a
/// restart must not redeploy and orphan the balances everyone already holds. If
/// local.json names two addresses that both still have code, this exits without
/// broadcasting anything.
///
/// Roles: both constructors grant DEFAULT_ADMIN and their operational role
/// (MINTER_ROLE / REGISTRAR_ROLE) to the treasury, so there is no separate grant
/// step here. The asserts below fail the deploy loudly if that ever stops being
/// true, rather than leaving a chain nobody can mint or register on.
contract Deploy is Script {
    uint256 internal constant DEFAULT_INITIAL_SUPPLY_VEE = 1_000_000;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury = vm.addr(deployerKey);

        string memory dir = vm.envOr("DEPLOYMENTS_DIR", string("../deployments"));
        string memory path = string.concat(dir, "/local.json");

        if (_alreadyDeployed(path)) {
            console.log("Deploy: local.json present and both contracts have code - nothing to do");
            return;
        }

        // THE OTHER DIRECTION, and the dangerous one. The guard above handles
        // "local.json survived, chain state was wiped". The reverse - local.json
        // gone, chain intact - reaches here and would deploy a SECOND VEEBux,
        // orphaning the first along with every balance in the game. It is not a
        // hypothetical: ./deployments is a bind mount and chain-state is a named
        // volume, so they have independent lifetimes and either can outlive the
        // other.
        //
        // Without local.json there is no address to check for code, so the
        // question "has anything been deployed here?" cannot be answered
        // directly. The deployer's nonce answers a WEAKER question honestly:
        // this account has transacted on this chain before, so this is not the
        // cold start the redeploy path assumes. Refusing costs an operator one
        // deliberate command; being wrong the other way costs the game its
        // money with no error at all.
        //
        // The durable fix is deterministic addresses (CREATE2 with a fixed
        // salt), which would make the address derivable without the file and
        // turn this into the same code-length check as above. That is a C1
        // contract change and belongs with a ruling, not with this amendment.
        // Conditioned on the FILE BEING ABSENT, not merely on _alreadyDeployed
        // being false. Those are different: local.json can be present and point
        // at dead addresses (a wiped chain), which is the forward case above and
        // must still redeploy. Guarding on the weaker condition made this fire
        // for that case too - so the message could be false, and, worse, this
        // check masked the forward one: a mutant disabling _alreadyDeployed was
        // caught here instead, which means neither guard was independently
        // tested. Two guards satisfied by one scenario is two guards you have
        // not tested.
        if (!vm.exists(path) && vm.getNonce(treasury) > 0) {
            revert(
                string.concat(
                    "Deploy: refusing to redeploy. No local.json, but the deployer has already ",
                    "transacted on this chain - a fresh deployment would orphan the existing ",
                    "VEEBux and every balance in it. Restore deployments/local.json, or wipe the ",
                    "chain-state volume if this chain really is disposable."
                )
            );
        }

        uint256 initialSupply = vm.envOr("INITIAL_SUPPLY_VEE", DEFAULT_INITIAL_SUPPLY_VEE) * 1e18;

        vm.startBroadcast(deployerKey);

        VEEBux vee = new VEEBux(treasury);
        NameRegistry registry = new NameRegistry(treasury);

        vee.mint(treasury, initialSupply);
        registry.registerFor("treasury.vee", treasury, treasury);

        vm.stopBroadcast();

        require(vee.hasRole(vee.MINTER_ROLE(), treasury), "Deploy: treasury lacks MINTER_ROLE");
        require(registry.hasRole(registry.REGISTRAR_ROLE(), treasury), "Deploy: treasury lacks REGISTRAR_ROLE");
        require(vee.balanceOf(treasury) == initialSupply, "Deploy: treasury was not seeded");
        require(registry.resolve("treasury.vee") == treasury, "Deploy: treasury.vee does not resolve");

        _writeDeployment(dir, path, address(vee), address(registry), treasury);

        console.log("Deploy: VEEBux      ", address(vee));
        console.log("Deploy: NameRegistry", address(registry));
        console.log("Deploy: treasury    ", treasury);
    }

    function _alreadyDeployed(string memory path) internal view returns (bool) {
        if (!vm.exists(path)) return false;

        string memory json = vm.readFile(path);
        // A malformed local.json reverts here on purpose: silently redeploying
        // over a file we could not read is how balances get orphaned.
        address vee = vm.parseJsonAddress(json, ".VEEBux");
        address registry = vm.parseJsonAddress(json, ".NameRegistry");

        // The file surviving is not enough - a wiped chain-state volume leaves
        // local.json pointing at addresses with no code, and that must redeploy.
        return vee.code.length > 0 && registry.code.length > 0;
    }

    function _writeDeployment(
        string memory dir,
        string memory path,
        address vee,
        address registry,
        address treasury
    ) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "VEEBux", vee);
        vm.serializeAddress(obj, "NameRegistry", registry);
        string memory out = vm.serializeAddress(obj, "treasury", treasury);

        vm.createDir(dir, true);
        vm.writeJson(out, path);
    }
}
