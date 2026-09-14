// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Token} from "../src/Token.sol";
import {NameRegistry} from "../src/NameRegistry.sol";

/// @title Deploy - brings up the modules a deployment's manifest asks for.
/// @notice Reads deployments/manifest.json, deploys each module in the order it
/// is listed, seeds each token with its own initialSupply, registers
/// `treasury.<tld>` when the deployment has both a names module and a token, and
/// writes deployments/local.json.
/// @dev IDEMPOTENT BY DESIGN (spec S3.3): compose runs this on every start, so a
/// restart must not redeploy and orphan the balances everyone already holds. If
/// local.json lists the same modules the manifest asks for and every address
/// still has code, this exits without broadcasting anything.
///
/// THERE IS NO BUILT-IN DEFAULT MANIFEST. A deployment declares its own modules
/// or it does not deploy. The alternative - a default baked in here - would put
/// one deployment's vocabulary in every other deployment's chain, and would make
/// "what is on this chain?" a question about this file rather than about the
/// deployment.
///
/// Roles: both constructors grant DEFAULT_ADMIN and their operational role
/// (MINTER_ROLE / REGISTRAR_ROLE) to the treasury, so there is no separate grant
/// step here. The asserts below fail the deploy loudly if that ever stops being
/// true, rather than leaving a chain nobody can mint or register on.
contract Deploy is Script {
    /// kind -> contract name. The other half of this table is `MODULES` in
    /// svc/src/modules.ts; they are two declarations of one fact.
    string internal constant KIND_TOKEN = "token";
    string internal constant KIND_NAMES = "names";
    string internal constant CONTRACT_TOKEN = "Token";
    string internal constant CONTRACT_NAMES = "NameRegistry";

    uint256 internal constant SCHEMA = 1;

    struct ModuleSpec {
        string kind;
        string key; // token only
        string name; // token only
        string symbol; // token only
        uint256 initialSupply; // token only, whole units
        string tld; // names only
    }

    /// The CLI entry point: reads the environment and hands it to `deploy`.
    ///
    /// The split is for the tests and is worth the one extra function. Forge
    /// runs test functions IN PARALLEL and `vm.setEnv` writes the whole
    /// PROCESS's environment, so a suite that configured each case through the
    /// environment had every case reading another case's directory - measured,
    /// seventeen failures, each naming a different test's path. Passing the
    /// configuration as arguments removes the shared mutable state instead of
    /// trying to sequence around it.
    function run() external {
        deploy(
            vm.envOr("DEPLOYMENTS_DIR", string("../deployments")),
            vm.envOr("INITIAL_SUPPLY_VEE", string(""))
        );
    }

    function deploy(string memory dir, string memory retiredSupplyEnv) public {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury = vm.addr(deployerKey);

        string memory path = string.concat(dir, "/local.json");
        string memory manifestPath = string.concat(dir, "/manifest.json");

        // Retired rather than ignored. Silently dropping it would leave an
        // operator's supply setting doing nothing with no way to notice.
        if (bytes(retiredSupplyEnv).length > 0) {
            revert("Deploy: INITIAL_SUPPLY_VEE is retired; put initialSupply in the manifest");
        }

        ModuleSpec[] memory mods = _readManifest(manifestPath);

        if (_alreadyDeployed(path, mods)) {
            console.log("Deploy: local.json matches the manifest and every address has code - nothing to do");
            return;
        }

        // THE OTHER DIRECTION, and the dangerous one. The guard above handles
        // "local.json survived, chain state was wiped". The reverse - local.json
        // gone, chain intact - reaches here and would deploy a SECOND set of
        // modules, orphaning the first along with every balance in the game. It
        // is not a hypothetical: ./deployments is a bind mount and chain-state
        // is a named volume, so they have independent lifetimes and either can
        // outlive the other.
        //
        // Without local.json there is no address to check for code, so the
        // question "has anything been deployed here?" cannot be answered
        // directly. The deployer's nonce answers a WEAKER question honestly:
        // this account has transacted on this chain before, so this is not the
        // cold start the redeploy path assumes. Refusing costs an operator one
        // deliberate command; being wrong the other way costs the game its
        // money with no error at all.
        //
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
                    "modules and every balance in them. Restore deployments/local.json, or wipe ",
                    "the chain-state volume if this chain really is disposable."
                )
            );
        }

        address[] memory addrs = new address[](mods.length);
        address namesAddr = address(0);
        string memory tld = "";
        bool haveToken = false;

        vm.startBroadcast(deployerKey);
        for (uint256 i = 0; i < mods.length; i++) {
            if (_eq(mods[i].kind, KIND_TOKEN)) {
                Token t = new Token{salt: saltFor(mods[i].kind, mods[i].key)}(
                    mods[i].name, mods[i].symbol, treasury
                );
                if (mods[i].initialSupply > 0) t.mint(treasury, mods[i].initialSupply * 1e18);
                addrs[i] = address(t);
                haveToken = true;
            } else {
                NameRegistry r = new NameRegistry{salt: saltFor(mods[i].kind, "")}(treasury);
                addrs[i] = address(r);
                namesAddr = address(r);
                tld = mods[i].tld;
            }
        }
        // `treasury.<tld>` names the treasury FOR A TOKEN'S BENEFIT, so it is
        // registered only when the deployment has both. A names-only deployment
        // gets a registry with nothing in it, which is correct: there is no
        // money for the treasury to hold.
        if (namesAddr != address(0) && haveToken) {
            NameRegistry(namesAddr).registerFor(string.concat("treasury.", tld), treasury, treasury);
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < mods.length; i++) {
            if (_eq(mods[i].kind, KIND_TOKEN)) {
                Token t = Token(addrs[i]);
                require(t.hasRole(t.MINTER_ROLE(), treasury), "Deploy: treasury lacks MINTER_ROLE");
                // BURNER_ROLE is granted to NOBODY at deploy. AccessControl has
                // no member enumeration, so "nobody" is asserted against the
                // only two addresses that could plausibly hold it here.
                require(!t.hasRole(t.BURNER_ROLE(), treasury), "Deploy: treasury must not hold BURNER_ROLE");
                require(!t.hasRole(t.BURNER_ROLE(), address(this)), "Deploy: script must not hold BURNER_ROLE");
                require(
                    t.balanceOf(treasury) == mods[i].initialSupply * 1e18, "Deploy: treasury was not seeded"
                );
            } else {
                NameRegistry r = NameRegistry(addrs[i]);
                require(r.hasRole(r.REGISTRAR_ROLE(), treasury), "Deploy: treasury lacks REGISTRAR_ROLE");
                if (haveToken) {
                    require(
                        r.resolve(string.concat("treasury.", tld)) == treasury,
                        "Deploy: treasury name does not resolve"
                    );
                }
            }
        }

        _writeDeployment(dir, path, mods, addrs, treasury);

        for (uint256 i = 0; i < mods.length; i++) {
            console.log("Deploy: module", mods[i].kind, addrs[i]);
        }
        console.log("Deploy: treasury    ", treasury);
    }

    // ── the manifest ────────────────────────────────────────────────────────

    function _readManifest(string memory manifestPath) internal view returns (ModuleSpec[] memory) {
        if (!vm.exists(manifestPath)) {
            revert(string.concat("Deploy: manifest: none found at ", manifestPath, "; a deployment must declare its modules"));
        }
        string memory json = vm.readFile(manifestPath);

        uint256 schema = vm.parseJsonUint(json, ".schema");
        if (schema != SCHEMA) {
            revert(string.concat("Deploy: manifest schema ", vm.toString(schema), " unsupported"));
        }

        uint256 n = 0;
        while (vm.keyExistsJson(json, string.concat(".modules[", vm.toString(n), "]"))) {
            n++;
        }
        if (n == 0) revert("Deploy: manifest: at least one module is required");

        ModuleSpec[] memory mods = new ModuleSpec[](n);
        uint256 namesSeen = 0;
        for (uint256 i = 0; i < n; i++) {
            string memory at = string.concat(".modules[", vm.toString(i), "]");
            string memory kind = vm.parseJsonString(json, string.concat(at, ".kind"));

            if (_eq(kind, KIND_TOKEN)) {
                mods[i].kind = KIND_TOKEN;
                mods[i].key = vm.parseJsonString(json, string.concat(at, ".key"));
                mods[i].name = vm.parseJsonString(json, string.concat(at, ".name"));
                mods[i].symbol = vm.parseJsonString(json, string.concat(at, ".symbol"));
                mods[i].initialSupply = vm.keyExistsJson(json, string.concat(at, ".initialSupply"))
                    ? _parseWholeUnits(vm.parseJsonString(json, string.concat(at, ".initialSupply")), mods[i].key)
                    : 0;

                if (!_isKey(mods[i].key)) revert(_bad(mods[i].key, "key"));
                if (!_isName(mods[i].name)) revert(_bad(mods[i].key, "name"));
                if (!_isSymbol(mods[i].symbol)) revert(_bad(mods[i].key, "symbol"));
                for (uint256 j = 0; j < i; j++) {
                    if (!_eq(mods[j].kind, KIND_TOKEN)) continue;
                    if (_eq(mods[j].key, mods[i].key)) {
                        revert(string.concat('Deploy: manifest: duplicate key "', mods[i].key, '"'));
                    }
                    if (_eq(mods[j].symbol, mods[i].symbol)) {
                        revert(string.concat('Deploy: manifest: duplicate symbol "', mods[i].symbol, '"'));
                    }
                }
            } else if (_eq(kind, KIND_NAMES)) {
                namesSeen++;
                if (namesSeen > 1) revert("Deploy: manifest: more than one names module");
                mods[i].kind = KIND_NAMES;
                mods[i].tld = vm.parseJsonString(json, string.concat(at, ".tld"));
                if (!_isKey(mods[i].tld)) revert("Deploy: manifest: names module has an invalid tld");
            } else {
                revert(string.concat('Deploy: manifest: unknown kind "', kind, '"'));
            }
        }
        return mods;
    }

    /// The CREATE2 salt for a module: `kind:key` for a token, the bare kind for
    /// a singleton like the registry.
    ///
    /// WHY DETERMINISTIC ADDRESSES AT ALL: with plain CREATE the address falls
    /// out of the deployer's NONCE, so the same manifest deployed on two chains
    /// - or in a different order on one - puts the same token at two addresses,
    /// and anything that recorded the first is silently wrong about the second.
    /// With CREATE2 the address depends only on the deployer, this salt and the
    /// init code, so order and nonce drop out. A code or constructor-argument
    /// change DOES move the address, and that is correct rather than a defect:
    /// it is a different contract.
    ///
    /// Under `forge script --broadcast` these route through the CREATE2 deployer
    /// Anvil predeploys at 0x4e59b44847b379578588920cA78FbF26c0B4956C - measured
    /// present on a fresh node, not assumed.
    function saltFor(string memory kind, string memory key) public pure returns (bytes32) {
        return bytes(key).length == 0
            ? keccak256(abi.encodePacked(kind))
            : keccak256(abi.encodePacked(kind, ":", key));
    }

    function _bad(string memory key, string memory field) internal pure returns (string memory) {
        return string.concat('Deploy: manifest: token "', key, '" has an invalid ', field);
    }

    /// `^\d{1,18}$` as whole units. Rejects an empty string, a sign, a decimal
    /// point and anything over 18 digits - the last because the multiply by 1e18
    /// happens in uint256 and a 19-digit supply times 1e18 is not obviously
    /// safe to anyone reading it.
    function _parseWholeUnits(string memory s, string memory key) internal pure returns (uint256) {
        bytes memory b = bytes(s);
        if (b.length == 0 || b.length > 18) revert(_bad(key, "initialSupply"));
        uint256 v = 0;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] < 0x30 || b[i] > 0x39) revert(_bad(key, "initialSupply"));
            v = v * 10 + (uint8(b[i]) - 48);
        }
        return v;
    }

    /// `^[a-z][a-z0-9]{0,15}$` - the shape of a module key and of a TLD.
    function _isKey(string memory s) internal pure returns (bool) {
        bytes memory b = bytes(s);
        if (b.length == 0 || b.length > 16) return false;
        if (b[0] < 0x61 || b[0] > 0x7a) return false;
        for (uint256 i = 1; i < b.length; i++) {
            bool lower = b[i] >= 0x61 && b[i] <= 0x7a;
            bool digit = b[i] >= 0x30 && b[i] <= 0x39;
            if (!lower && !digit) return false;
        }
        return true;
    }

    /// `^[A-Z][A-Z0-9]{0,9}$`
    function _isSymbol(string memory s) internal pure returns (bool) {
        bytes memory b = bytes(s);
        if (b.length == 0 || b.length > 10) return false;
        if (b[0] < 0x41 || b[0] > 0x5a) return false;
        for (uint256 i = 1; i < b.length; i++) {
            bool upper = b[i] >= 0x41 && b[i] <= 0x5a;
            bool digit = b[i] >= 0x30 && b[i] <= 0x39;
            if (!upper && !digit) return false;
        }
        return true;
    }

    /// 1-64 characters. Deliberately no character class: a token's display name
    /// is prose and the chain does not care what is in it.
    function _isName(string memory s) internal pure returns (bool) {
        uint256 n = bytes(s).length;
        return n > 0 && n <= 64;
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    // ── local.json ──────────────────────────────────────────────────────────

    /// True only if the existing local.json lists EXACTLY the manifest's
    /// modules, in order, and every address still has code.
    ///
    /// A file whose list DIFFERS from the manifest is a refusal rather than a
    /// partial top-up: deploying only the new entries would leave a chain whose
    /// contracts were deployed under two different manifests, and nothing
    /// afterwards could tell which. The operator redeploys on a fresh chain or
    /// fixes the manifest; both are one deliberate act.
    function _alreadyDeployed(string memory path, ModuleSpec[] memory mods) internal view returns (bool) {
        if (!vm.exists(path)) return false;

        string memory json = vm.readFile(path);
        // A malformed local.json reverts here on purpose: silently redeploying
        // over a file we could not read is how balances get orphaned.
        uint256 n = 0;
        while (vm.keyExistsJson(json, string.concat(".modules[", vm.toString(n), "]"))) {
            n++;
        }

        string memory declared = "";
        for (uint256 i = 0; i < n; i++) {
            string memory at = string.concat(".modules[", vm.toString(i), "]");
            string memory kind = vm.parseJsonString(json, string.concat(at, ".kind"));
            string memory key =
                vm.keyExistsJson(json, string.concat(at, ".key")) ? vm.parseJsonString(json, string.concat(at, ".key")) : "";
            declared = string.concat(declared, i == 0 ? "" : ",", _eq(kind, KIND_TOKEN) ? key : kind);
        }

        string memory asked = "";
        for (uint256 i = 0; i < mods.length; i++) {
            asked = string.concat(asked, i == 0 ? "" : ",", _eq(mods[i].kind, KIND_TOKEN) ? mods[i].key : mods[i].kind);
        }

        if (!_eq(declared, asked)) {
            revert(
                string.concat(
                    "Deploy: local.json declares modules ",
                    declared,
                    "; manifest asks for ",
                    asked,
                    " - redeploy on a fresh chain or fix the manifest"
                )
            );
        }

        // The file surviving is not enough - a wiped chain-state volume leaves
        // local.json pointing at addresses with no code, and that must redeploy.
        for (uint256 i = 0; i < n; i++) {
            address a = vm.parseJsonAddress(json, string.concat(".modules[", vm.toString(i), "].address"));
            if (a.code.length == 0) return false;
        }
        return n > 0;
    }

    function _writeDeployment(
        string memory dir,
        string memory path,
        ModuleSpec[] memory mods,
        address[] memory addrs,
        address treasury
    ) internal {
        // One objectKey per object, and the entries are embedded as raw JSON
        // rather than serialized as strings - `vm.serializeString` on a JSON
        // string would escape it and produce an array of strings, which
        // `parseJsonAddress(".modules[0].address")` cannot read.
        string memory arr = "[";
        for (uint256 i = 0; i < mods.length; i++) {
            bool isToken = _eq(mods[i].kind, KIND_TOKEN);
            string memory entry = string.concat(
                '{"kind":"',
                mods[i].kind,
                isToken ? string.concat('","key":"', mods[i].key) : "",
                '","contract":"',
                isToken ? CONTRACT_TOKEN : CONTRACT_NAMES,
                '","address":"',
                vm.toString(addrs[i]),
                '"',
                isToken ? "" : string.concat(',"tld":"', mods[i].tld, '"'),
                "}"
            );
            arr = string.concat(arr, i == 0 ? "" : ",", entry);
        }
        arr = string.concat(arr, "]");

        string memory out = string.concat(
            '{"schema":',
            vm.toString(SCHEMA),
            ',"chainId":',
            vm.toString(block.chainid),
            ',"treasury":"',
            vm.toString(treasury),
            '","modules":',
            arr,
            "}"
        );

        vm.createDir(dir, true);
        vm.writeJson(out, path);
    }
}
