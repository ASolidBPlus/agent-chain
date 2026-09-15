// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Token} from "../src/Token.sol";
import {NameRegistry} from "../src/NameRegistry.sol";
import {Converter} from "../src/Converter.sol";

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
    string internal constant KIND_CONVERTER = "converter";
    /// A custom contract deployed by name from the manifest. Unlike the kinds
    /// above there is no fixed contract for it: the manifest's `contract` field
    /// names the Solidity contract, and `local.json` records that name.
    string internal constant KIND_CONTRACT = "contract";
    string internal constant CONTRACT_TOKEN = "Token";
    string internal constant CONTRACT_NAMES = "NameRegistry";
    string internal constant CONTRACT_CONVERTER = "Converter";

    uint256 internal constant SCHEMA = 1;

    // Mirror Converter's own constants so the manifest's decimal rates and the
    // loop check can be validated here, before any setPair, with readable
    // messages instead of the contract's raw errors.
    uint256 internal constant RATE_SCALE = 1e18;
    uint256 internal constant MAX_RATE = 1e30;

    struct ModuleSpec {
        string kind;
        string key; // token and contract; unique across ALL kinds (see _readManifest)
        // TWO MEANINGS, TWO VALIDATION RULES, one field: for a `token` this is the
        // ERC-20 display name (free prose, 1-64 chars, `_isName`); for a
        // `contract` it is the Solidity contract name that must match an artifact
        // (`Fixture` -> out/Fixture.sol/Fixture.json). Do not widen the token
        // rule without checking it does not loosen the contract one.
        string name;
        string symbol; // token only
        uint256 initialSupply; // token only, whole units
        string tld; // names only
    }

    struct ConverterPair {
        string source; // a token key from this manifest
        string target; // a token key from this manifest, != source
        uint256 rate; // RATE_SCALE-scaled, 0 < rate <= MAX_RATE
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
            vm.envOr("INITIAL_SUPPLY_VEE", string("")),
            vm.envOr("ALLOW_FRESH_DEPLOY", string(""))
        );
    }

    /// `allowFreshDeploy` is READ FROM THE ENV BY `run()` AND PASSED IN, exactly
    /// as the retired supply variable is, rather than read here.
    ///
    /// Not a style choice: `vm.setEnv` writes a PROCESS-WIDE variable and forge
    /// runs test contracts in PARALLEL, so a test that unset this to exercise
    /// the refusal unset it for every suite running beside it. Measured - six
    /// unrelated deploy tests failed with this refusal, in a run where the only
    /// change was one test setting the variable to "". A parameter is a value
    /// one call has; an env var is a value the whole process shares.
    function deploy(string memory dir, string memory retiredSupplyEnv, string memory allowFreshDeploy)
        public
    {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury = vm.addr(deployerKey);

        string memory path = string.concat(dir, "/local.json");

        // Retired rather than ignored. Silently dropping it would leave an
        // operator's supply setting doing nothing with no way to notice.
        if (bytes(retiredSupplyEnv).length > 0) {
            revert("Deploy: INITIAL_SUPPLY_VEE is retired; put initialSupply in the manifest");
        }

        // READ ONCE AND PASSED DOWN. It was re-read by `_readConverterPairs`,
        // by `_deployContract` for every custom contract, and - once the cache
        // check arrived - by `_expectedAddress` for every one again. N+2 reads
        // of a file that cannot change mid-run, and N+2 chances to act on two
        // different versions of it if it ever did.
        string memory manifest = _readManifestFile(string.concat(dir, "/manifest.json"));
        ModuleSpec[] memory mods = _readManifest(manifest);
        // Validated up front so a bad converter manifest fails fast, with the
        // readable message, before anything is broadcast.
        ConverterPair[] memory pairs = _readConverterPairs(manifest, mods);
        // Custom-contract artifacts are checked before broadcast so a missing one
        // is a readable refusal rather than a raw getCode revert mid-deploy. Their
        // constructor args are read from the manifest at deploy time in
        // _deployContract, where @key references resolve to earlier addresses.
        _requireContractArtifacts(mods);

        // THE CACHE, CHECKED RATHER THAN BELIEVED, and planned PER MODULE.
        // In its own function because `deploy()` is already at the stack limit -
        // the same reason `_deployContract` lives apart from it.
        Plan memory plan = _plan(dir, path, manifest, mods, treasury, allowFreshDeploy);
        if (plan.done) return;

        address namesAddr = address(0);
        address converterAddr = address(0);
        string memory tld = "";
        bool haveToken = false;

        vm.startBroadcast(deployerKey);
        for (uint256 i = 0; i < mods.length; i++) {
            // PER-MODULE IDEMPOTENCY. A module already live at its derived
            // address is left alone; only the empty ones are deployed. Without
            // this a partially-wiped chain - one module gone, the rest intact -
            // had no outcome at all: the run either redeployed everything, which
            // reverts inside `new` at the first address that still holds code,
            // or refused wholesale and left the gap unfilled.
            //
            // The address is the DERIVED one either way, so a skipped module and
            // a deployed one are described identically afterwards.
            if (!plan.needsDeploy[i]) {
                console.log("Deploy: already deployed, skipping", mods[i].kind, plan.addrs[i]);
                // THE WIRING BELOW STILL NEEDS THESE. A skipped names or
                // converter module that left these at zero would make the
                // treasury registration and the pair wiring silently do
                // nothing - the failure mode of a guard that returns early
                // without carrying its outputs forward.
                if (_eq(mods[i].kind, KIND_NAMES)) {
                    namesAddr = plan.addrs[i];
                    tld = mods[i].tld;
                } else if (_eq(mods[i].kind, KIND_CONVERTER)) {
                    converterAddr = plan.addrs[i];
                } else if (_eq(mods[i].kind, KIND_TOKEN)) {
                    haveToken = true;
                }
                continue;
            }
            if (_eq(mods[i].kind, KIND_TOKEN)) {
                Token t = new Token{salt: saltFor(mods[i].kind, mods[i].key)}(
                    mods[i].name, mods[i].symbol, treasury
                );
                if (mods[i].initialSupply > 0) t.mint(treasury, mods[i].initialSupply * 1e18);
                plan.addrs[i] = address(t);
                haveToken = true;
            } else if (_eq(mods[i].kind, KIND_NAMES)) {
                NameRegistry r = new NameRegistry{salt: saltFor(mods[i].kind, "")}(treasury);
                plan.addrs[i] = address(r);
                namesAddr = address(r);
                tld = mods[i].tld;
            } else if (_eq(mods[i].kind, KIND_CONVERTER)) {
                // Converter: deployed with no pairs and no grants yet; both are
                // wired below, once every token address is known. Salted with the
                // bare kind (one converter per deployment) so its address is
                // deterministic like every other module's.
                Converter c = new Converter{salt: saltFor(KIND_CONVERTER, "")}(treasury);
                plan.addrs[i] = address(c);
                converterAddr = address(c);
            } else {
                // A custom contract, deployed by name with static-typed args. Kept
                // in its own function so deploy()'s stack stays within limits.
                // Registered contracts get NO role grants (spec S1.1); any role
                // they need comes later through admin-call.
                plan.addrs[i] = _deployContract(manifest, i, mods, plan.addrs, treasury);
            }
        }
        // `treasury.<tld>` names the treasury FOR A TOKEN'S BENEFIT, so it is
        // registered only when the deployment has both. A names-only deployment
        // gets a registry with nothing in it, which is correct: there is no
        // money for the treasury to hold.
        if (namesAddr != address(0) && haveToken) {
            // ONLY IF IT IS NOT ALREADY THERE. With per-module idempotency the
            // registry can be a survivor while a token beside it is redeployed,
            // and registering a name that already resolves is a refusal rather
            // than a no-op - so the run would fail on its second pass over a
            // registry it had just been right to keep.
            string memory treasuryName = string.concat("treasury.", tld);
            if (NameRegistry(namesAddr).resolve(treasuryName) == address(0)) {
                NameRegistry(namesAddr).registerFor(treasuryName, treasury, treasury);
            }
        }
        // Wire the converter LAST: each pair needs its two token addresses, and
        // the converter is the only holder of BURNER_ROLE on any token. The
        // treasury keeps MINTER_ROLE on every token; the converter is an
        // additional minter on each target, never a replacement.
        if (converterAddr != address(0)) {
            for (uint256 j = 0; j < pairs.length; j++) {
                address src = _tokenAddrByKey(mods, plan.addrs, pairs[j].source);
                address tgt = _tokenAddrByKey(mods, plan.addrs, pairs[j].target);
                Converter(converterAddr).setPair(src, tgt, pairs[j].rate);
                Token(src).grantRole(Token(src).BURNER_ROLE(), converterAddr);
                Token(tgt).grantRole(Token(tgt).MINTER_ROLE(), converterAddr);
            }
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < mods.length; i++) {
            if (_eq(mods[i].kind, KIND_TOKEN)) {
                Token t = Token(plan.addrs[i]);
                require(t.hasRole(t.MINTER_ROLE(), treasury), "Deploy: treasury lacks MINTER_ROLE");
                // FREEZER_ROLE is granted by Token's CONSTRUCTOR, not by this
                // script - so this asserts a property of the contract rather
                // than confirming its own work, which is the more useful
                // direction: a constructor that stopped granting it would fail
                // the deploy instead of producing a chain where no freeze is
                // possible and nothing says so until the first one is tried.
                require(t.hasRole(t.FREEZER_ROLE(), treasury), "Deploy: treasury lacks FREEZER_ROLE");
                // BURNER_ROLE is held by the CONVERTER alone when a deployment
                // has one, and by NOBODY otherwise. AccessControl has no member
                // enumeration, so that is asserted against the address that could
                // plausibly hold it: the treasury, which is this token's
                // DEFAULT_ADMIN and the only account this script grants to. The
                // converter's own grants are asserted in its branch below.
                //
                // THERE WAS A SECOND ASSERTION HERE, against `address(this)`,
                // and finding it cost a compose smoke. `forge script
                // --broadcast` REFUSES `address(this)` in a script contract -
                // "script contracts are ephemeral and their addresses should not
                // be relied upon" - while `forge test` allows it. So it passed
                // locally and reverted the deploy inside the container, which is
                // the only place it ran for real. Do not reinstate it here.
                //
                // It was also asking the wrong question: under broadcast the
                // deployer is the treasury EOA and the script contract holds
                // nothing, so the check could only ever have been vacuous. The
                // exhaustive "nobody holds it" claim lives in Token.t.sol, where
                // there is no broadcast and the addresses are real.
                require(!t.hasRole(t.BURNER_ROLE(), treasury), "Deploy: treasury must not hold BURNER_ROLE");
                // THE CONVERTER MUST NEVER FREEZE. Nothing grants it
                // FREEZER_ROLE, so this is asserting something no line of code
                // makes true - which is the reason to assert it rather than the
                // reason not to. The grants a few lines up hand the converter
                // BURNER and MINTER on the tokens it converts between; a fifth
                // grant added there later would be one word from being a
                // contract that can freeze the accounts it burns from, and this
                // is what would notice.
                //
                // Checked rather than assumed, mirroring the BURNER-not-treasury
                // assertion directly above.
                if (converterAddr != address(0)) {
                    require(
                        !t.hasRole(t.FREEZER_ROLE(), converterAddr),
                        "Deploy: converter must not hold FREEZER_ROLE"
                    );
                }
                require(
                    t.balanceOf(treasury) == mods[i].initialSupply * 1e18, "Deploy: treasury was not seeded"
                );
                // FINDING 20. WHO ADMINISTERS THIS TOKEN, asserted rather than
                // assumed. DEFAULT_ADMIN_ROLE is the role that grants every
                // other one, so an unintended holder is not a smaller problem
                // than an unintended MINTER - it is the same problem with one
                // extra step.
                //
                // The three negatives are the ones a mistake would produce. The
                // CONVERTER is granted BURNER and MINTER a few lines up, and a
                // fourth grant added there later would be one word from an admin
                // that can grant itself anything. `address(0)` is what an
                // uninitialised admin argument looks like, and it is a hole
                // nobody holds and everybody can see. The SCRIPT address cannot
                // be asserted here - `forge script --broadcast` refuses
                // `address(this)` in a script contract, which cost a compose
                // smoke once already - so Token.t.sol makes the exhaustive
                // claim where the addresses are real and there is no broadcast.
                require(
                    t.hasRole(t.DEFAULT_ADMIN_ROLE(), treasury), "Deploy: treasury lacks DEFAULT_ADMIN_ROLE"
                );
                require(
                    !t.hasRole(t.DEFAULT_ADMIN_ROLE(), address(0)),
                    "Deploy: address(0) must not hold DEFAULT_ADMIN_ROLE"
                );
                if (converterAddr != address(0)) {
                    require(
                        !t.hasRole(t.DEFAULT_ADMIN_ROLE(), converterAddr),
                        "Deploy: converter must not hold DEFAULT_ADMIN_ROLE"
                    );
                }
            } else if (_eq(mods[i].kind, KIND_NAMES)) {
                NameRegistry r = NameRegistry(plan.addrs[i]);
                require(r.hasRole(r.REGISTRAR_ROLE(), treasury), "Deploy: treasury lacks REGISTRAR_ROLE");
                // FINDING 20, the registry's half. A registry whose admin is not
                // the treasury is a registry someone else can hand names out of,
                // and a name is what every payment in this system resolves
                // through.
                require(
                    r.hasRole(r.DEFAULT_ADMIN_ROLE(), treasury), "Deploy: treasury lacks DEFAULT_ADMIN_ROLE"
                );
                require(
                    !r.hasRole(r.DEFAULT_ADMIN_ROLE(), address(0)),
                    "Deploy: address(0) must not hold DEFAULT_ADMIN_ROLE"
                );
                if (converterAddr != address(0)) {
                    require(
                        !r.hasRole(r.DEFAULT_ADMIN_ROLE(), converterAddr),
                        "Deploy: converter must not hold DEFAULT_ADMIN_ROLE on the registry"
                    );
                }
                if (haveToken) {
                    require(
                        r.resolve(string.concat("treasury.", tld)) == treasury,
                        "Deploy: treasury name does not resolve"
                    );
                }
            } else if (_eq(mods[i].kind, KIND_CONVERTER)) {
                Converter c = Converter(plan.addrs[i]);
                // FINDING 20, the converter's half. RATE_ADMIN sets the rate at
                // which one token becomes another - the exchange rate of the
                // game's economy - so the question of who holds it is the
                // question of who can print value by moving a number.
                require(
                    c.hasRole(c.DEFAULT_ADMIN_ROLE(), treasury), "Deploy: treasury lacks DEFAULT_ADMIN_ROLE"
                );
                require(
                    c.hasRole(c.RATE_ADMIN_ROLE(), treasury), "Deploy: treasury lacks RATE_ADMIN_ROLE"
                );
                require(
                    !c.hasRole(c.DEFAULT_ADMIN_ROLE(), address(0)),
                    "Deploy: address(0) must not hold DEFAULT_ADMIN_ROLE"
                );
                require(
                    !c.hasRole(c.RATE_ADMIN_ROLE(), address(0)),
                    "Deploy: address(0) must not hold RATE_ADMIN_ROLE"
                );
                for (uint256 j = 0; j < pairs.length; j++) {
                    address src = _tokenAddrByKey(mods, plan.addrs, pairs[j].source);
                    address tgt = _tokenAddrByKey(mods, plan.addrs, pairs[j].target);
                    (,, bool exists) = c.pair(src, tgt);
                    require(exists, "Deploy: converter pair was not set");
                    require(
                        Token(src).hasRole(Token(src).BURNER_ROLE(), address(c)),
                        "Deploy: converter lacks BURNER_ROLE on a source token"
                    );
                    require(
                        Token(tgt).hasRole(Token(tgt).MINTER_ROLE(), address(c)),
                        "Deploy: converter lacks MINTER_ROLE on a target token"
                    );
                }
            } else {
                // A custom contract: it exists and has code. No roles are asserted
                // because the deploy grants it none.
                require(plan.addrs[i].code.length > 0, "Deploy: contract has no code");
            }
        }

        _writeDeployment(dir, path, mods, plan.addrs, treasury);

        for (uint256 i = 0; i < mods.length; i++) {
            console.log("Deploy: module", mods[i].kind, plan.addrs[i]);
        }
        console.log("Deploy: treasury    ", treasury);
    }

    // ── the manifest ────────────────────────────────────────────────────────

    /// THE ONE READ. Separate from the parser so the not-found refusal can name
    /// the path, which the parser no longer sees.
    function _readManifestFile(string memory manifestPath) internal view returns (string memory) {
        if (!vm.exists(manifestPath)) {
            revert(
                string.concat(
                    "Deploy: manifest: none found at ", manifestPath, "; a deployment must declare its modules"
                )
            );
        }
        return vm.readFile(manifestPath);
    }

    function _readManifest(string memory json) internal view returns (ModuleSpec[] memory) {

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
        uint256 convertersSeen = 0;
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
                // Symbol uniqueness is token-only; key uniqueness is checked
                // across all kinds below.
                for (uint256 j = 0; j < i; j++) {
                    if (!_eq(mods[j].kind, KIND_TOKEN)) continue;
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
            } else if (_eq(kind, KIND_CONVERTER)) {
                convertersSeen++;
                if (convertersSeen > 1) revert("Deploy: manifest: more than one converter module");
                mods[i].kind = KIND_CONVERTER;
                // Pairs are parsed and validated in `_readConverterPairs`, which
                // needs the full module list to resolve source/target keys.
            } else if (_eq(kind, KIND_CONTRACT)) {
                mods[i].kind = KIND_CONTRACT;
                mods[i].key = vm.parseJsonString(json, string.concat(at, ".key"));
                // `name` holds the Solidity contract name (see the struct). Its
                // artifact is checked before broadcast in _requireContractArtifacts;
                // constructor args are validated and encoded at deploy time in
                // _encodeContractArgs, where @key references resolve to addresses
                // deployed earlier in the list.
                mods[i].name = vm.parseJsonString(json, string.concat(at, ".contract"));
                if (!_isKey(mods[i].key)) revert(_bad(mods[i].key, "key"));
            } else {
                revert(string.concat('Deploy: manifest: unknown kind "', kind, '"'));
            }

            // ONE KEY NAMESPACE across all kinds: token and contract keys, and the
            // implicit keys of the singletons ("names", "converter"), must all be
            // distinct - the key is what _alreadyDeployed and local.json identify
            // an entry by, so two entries sharing one is the ambiguity that guard
            // exists to prevent. chain-svc's loadDeployment mirrors this exact rule,
            // including the implicit-key strings "names" and "converter".
            string memory identifier = _effectiveKey(mods[i]);
            for (uint256 j = 0; j < i; j++) {
                if (_eq(_effectiveKey(mods[j]), identifier)) {
                    revert(string.concat('Deploy: manifest: duplicate key "', identifier, '"'));
                }
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

    // ── the converter ─────────────────────────────────────────────────────────

    /// Reads and validates the converter module's pairs, or the empty array when
    /// the manifest has no converter. Each pair's source and target must be token
    /// keys from this manifest that exist and differ; the rate is a decimal
    /// string in (0, MAX_RATE]; and no pair may combine with its reverse to mint
    /// value on a round trip. Validated here so a bad manifest fails with a
    /// readable message rather than the contract's raw error.
    function _readConverterPairs(string memory json, ModuleSpec[] memory mods)
        internal
        view
        returns (ConverterPair[] memory)
    {
        uint256 convIdx = type(uint256).max;
        for (uint256 i = 0; i < mods.length; i++) {
            if (_eq(mods[i].kind, KIND_CONVERTER)) {
                convIdx = i;
                break;
            }
        }
        if (convIdx == type(uint256).max) return new ConverterPair[](0);

        string memory base = string.concat(".modules[", vm.toString(convIdx), "].pairs");

        uint256 n = 0;
        while (vm.keyExistsJson(json, string.concat(base, "[", vm.toString(n), "]"))) {
            n++;
        }
        if (n == 0) revert("Deploy: manifest: converter has no pairs");

        ConverterPair[] memory pairs = new ConverterPair[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory at = string.concat(base, "[", vm.toString(i), "]");
            pairs[i].source = vm.parseJsonString(json, string.concat(at, ".source"));
            pairs[i].target = vm.parseJsonString(json, string.concat(at, ".target"));

            if (_eq(pairs[i].source, pairs[i].target)) {
                revert(string.concat('Deploy: manifest: converter pair "', pairs[i].source, '" converts to itself'));
            }
            if (!_isTokenKey(mods, pairs[i].source)) {
                revert(
                    string.concat('Deploy: manifest: converter pair source "', pairs[i].source, '" is not a token key')
                );
            }
            if (!_isTokenKey(mods, pairs[i].target)) {
                revert(
                    string.concat('Deploy: manifest: converter pair target "', pairs[i].target, '" is not a token key')
                );
            }
            pairs[i].rate = parseDecimal18(vm.parseJsonString(json, string.concat(at, ".rate")));
        }

        // Loop guard, computed here so a value-minting manifest is a readable
        // refusal rather than the contract's LoopMintsValue. Each unordered pair
        // is checked once against its reverse.
        for (uint256 i = 0; i < n; i++) {
            for (uint256 k = i + 1; k < n; k++) {
                if (_eq(pairs[i].source, pairs[k].target) && _eq(pairs[i].target, pairs[k].source)) {
                    if (pairs[i].rate * pairs[k].rate > RATE_SCALE * RATE_SCALE) {
                        revert(
                            string.concat(
                                "Deploy: manifest: pair ",
                                pairs[i].source,
                                "->",
                                pairs[i].target,
                                " x ",
                                pairs[k].source,
                                "->",
                                pairs[k].target,
                                " mints value"
                            )
                        );
                    }
                }
            }
        }
        return pairs;
    }

    /// Parses a decimal string with up to 18 places into a RATE_SCALE-scaled
    /// integer. forge-std has no decimal parser, so the split on the first dot is
    /// manual; the two digit runs go through `vm.parseUint`.
    function parseDecimal18(string memory s) public pure returns (uint256) {
        bytes memory b = bytes(s);
        uint256 dotPos = b.length; // sentinel: no dot
        bool sawDot = false;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == 0x2e) {
                if (sawDot) revert(_notDecimal(s)); // a second dot
                sawDot = true;
                dotPos = i;
            } else if (b[i] < 0x30 || b[i] > 0x39) {
                revert(_notDecimal(s)); // a byte that is neither a digit nor the dot
            }
        }
        // The integer part is required: "" and ".5" both have an empty one.
        if (dotPos == 0) revert(_notDecimal(s));

        uint256 intPart = vm.parseUint(_slice(b, 0, dotPos));
        // Bound the integer part BEFORE scaling: MAX_RATE / RATE_SCALE = 1e12
        // whole units. Past that, intPart * RATE_SCALE would Panic(0x11) on
        // overflow instead of giving the readable message below.
        if (intPart > MAX_RATE / RATE_SCALE) revert("Deploy: manifest: rate exceeds MAX_RATE");
        uint256 result = intPart * RATE_SCALE;

        if (sawDot) {
            uint256 fracLen = b.length - dotPos - 1;
            if (fracLen > 18) revert("Deploy: manifest: rate has more than 18 decimal places");
            if (fracLen > 0) {
                uint256 frac = vm.parseUint(_slice(b, dotPos + 1, b.length));
                result += frac * (10 ** (18 - fracLen));
            }
        }

        if (result == 0) revert("Deploy: manifest: rate must be > 0");
        if (result > MAX_RATE) revert("Deploy: manifest: rate exceeds MAX_RATE");
        return result;
    }

    function _notDecimal(string memory s) internal pure returns (string memory) {
        return string.concat('Deploy: manifest: rate "', s, '" is not a decimal');
    }

    function _slice(bytes memory b, uint256 start, uint256 end) internal pure returns (string memory) {
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = b[i];
        }
        return string(out);
    }

    function _isTokenKey(ModuleSpec[] memory mods, string memory key) internal pure returns (bool) {
        for (uint256 i = 0; i < mods.length; i++) {
            if (_eq(mods[i].kind, KIND_TOKEN) && _eq(mods[i].key, key)) return true;
        }
        return false;
    }

    function _tokenAddrByKey(ModuleSpec[] memory mods, address[] memory addrs, string memory key)
        internal
        pure
        returns (address)
    {
        for (uint256 i = 0; i < mods.length; i++) {
            if (_eq(mods[i].kind, KIND_TOKEN) && _eq(mods[i].key, key)) return addrs[i];
        }
        revert(string.concat('Deploy: manifest: converter pair references unknown token "', key, '"'));
    }

    // ── custom contracts ────────────────────────────────────────────────────

    /// The identifier an entry occupies in the one shared key namespace: its key
    /// for token/contract, its kind ("names"/"converter") for the singletons.
    function _effectiveKey(ModuleSpec memory m) internal pure returns (string memory) {
        return (_eq(m.kind, KIND_TOKEN) || _eq(m.kind, KIND_CONTRACT)) ? m.key : m.kind;
    }

    /// Reverts, before anything is broadcast, for any custom-contract entry whose
    /// Solidity contract has no compiled artifact - a readable message instead of
    /// forge's raw getCode failure mid-deploy.
    function _requireContractArtifacts(ModuleSpec[] memory mods) internal view {
        for (uint256 i = 0; i < mods.length; i++) {
            if (!_eq(mods[i].kind, KIND_CONTRACT)) continue;
            try this.getCodeExternal(string.concat(mods[i].name, ".sol:", mods[i].name)) {}
            catch {
                revert(string.concat('Deploy: manifest: no artifact for "', mods[i].name, '"'));
            }
        }
    }

    /// An external wrapper purely so `_requireContractArtifacts` can try/catch the
    /// getCode cheatcode; a missing artifact reverts and the catch renames it.
    function getCodeExternal(string memory what) external view returns (bytes memory) {
        return vm.getCode(what);
    }

    /// Deploys one custom contract: getCode ‖ encoded args as init code, CREATE2
    /// with salt "contract:<key>". Called from deploy()'s broadcast loop as an
    /// internal function, so the assembly create2 runs in the same broadcast frame
    /// and is routed through the 0x4e59 factory exactly as new{salt} is - the
    /// address matches computeCreate2Address(salt, keccak256(initcode), 0x4e59)
    /// (measured). Its own function so deploy() stays within the stack limit.
    function _deployContract(
        string memory json,
        uint256 idx,
        ModuleSpec[] memory mods,
        address[] memory addrs,
        address treasury
    ) internal returns (address deployed) {
        bytes memory initcode = abi.encodePacked(
            vm.getCode(string.concat(mods[idx].name, ".sol:", mods[idx].name)),
            _encodeContractArgs(json, idx, mods, addrs, treasury)
        );
        bytes32 salt = saltFor(KIND_CONTRACT, mods[idx].key);
        /// @solidity memory-safe-assembly
        assembly {
            deployed := create2(0, add(initcode, 0x20), mload(initcode), salt)
        }
        require(deployed != address(0), "Deploy: contract deployment failed");
    }

    /// The constructor payload for a custom contract. Static types only, so
    /// abi.encode(each) concatenated equals abi.encode(all) and no type-directed
    /// encoder is needed. Empty when the entry has no `args`.
    function _encodeContractArgs(
        string memory json,
        uint256 idx,
        ModuleSpec[] memory mods,
        address[] memory addrs,
        address treasury
    ) internal view returns (bytes memory encoded) {
        string memory base = string.concat(".modules[", vm.toString(idx), "].args");
        uint256 n = 0;
        while (vm.keyExistsJson(json, string.concat(base, "[", vm.toString(n), "]"))) {
            n++;
        }
        encoded = "";
        for (uint256 a = 0; a < n; a++) {
            string memory at = string.concat(base, "[", vm.toString(a), "]");
            string memory typ = vm.parseJsonString(json, string.concat(at, ".type"));
            string memory val = vm.parseJsonString(json, string.concat(at, ".value"));
            encoded = abi.encodePacked(encoded, _encodeOneArg(typ, val, idx, mods, addrs, treasury));
        }
    }

    function _encodeOneArg(
        string memory typ,
        string memory val,
        uint256 idx,
        ModuleSpec[] memory mods,
        address[] memory addrs,
        address treasury
    ) internal view returns (bytes memory) {
        if (_eq(typ, "address")) return abi.encode(_resolveArgAddress(val, idx, mods, addrs, treasury));
        if (_eq(typ, "uint256")) return abi.encode(vm.parseUint(val));
        if (_eq(typ, "bool")) {
            if (_eq(val, "true")) return abi.encode(true);
            if (_eq(val, "false")) return abi.encode(false);
            revert(string.concat('Deploy: manifest: bool arg must be "true" or "false", got "', val, '"'));
        }
        if (_eq(typ, "bytes32")) return abi.encode(vm.parseBytes32(val));
        revert(
            string.concat(
                'Deploy: manifest: constructor arg type "', typ, '" is not supported; use an initialiser function'
            )
        );
    }

    // Resolves an `address` arg value: "@treasury", "@<key>" of an entry deployed
    // EARLIER in the list, or a literal 0x address. A forward or unknown "@"
    // reference reverts - its address is not known yet.
    function _resolveArgAddress(
        string memory val,
        uint256 idx,
        ModuleSpec[] memory mods,
        address[] memory addrs,
        address treasury
    ) internal view returns (address) {
        bytes memory b = bytes(val);
        if (b.length > 0 && b[0] == 0x40) {
            // '@'
            string memory ref = _slice(b, 1, b.length);
            if (_eq(ref, "treasury")) return treasury;
            for (uint256 j = 0; j < idx; j++) {
                if (_eq(_effectiveKey(mods[j]), ref)) return addrs[j];
            }
            revert(string.concat('Deploy: manifest: "', val, '" is not deployed yet'));
        }
        return vm.parseAddress(val);
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

    /// THE CANONICAL CREATE2 DEPLOYER. Anvil predeploys it, and a salted `new`
    /// inside a Script-derived contract under broadcast routes through it -
    /// which is what makes an address the same under `forge test` and under
    /// `forge script --broadcast`, and is why the cache re-derives against this
    /// and not against the treasury. Measured in Create2Probe.t.sol's fourth
    /// case; the same shape inside a TEST contract gives the broadcaster, which
    /// is the wrong answer and the easy mistake.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// What the cache records for one module.
    struct CacheEntry {
        address addr;
        /// The module's runtime codehash at write time, or zero on a file
        /// written before codehashes were recorded.
        bytes32 codehash;
    }

    /// THE COMPARISON KEY, on both sides of every cache check: `kind:key`.
    ///
    /// `_effectiveKey` collapses to the bare key for tokens and contracts and to
    /// the bare kind for the singletons, so a token keyed "names" and the names
    /// module both reduce to "names". The manifest's own uniqueness check uses
    /// that collapse and refuses such a manifest - but the cache is a FILE, and
    /// a file is not required to have come from a manifest this script accepted.
    /// Qualifying by kind makes the two unconfusable whatever the file says.
    function _cacheKey(string memory kind, string memory key) internal pure returns (string memory) {
        return string.concat(kind, ":", key);
    }

    /// True only if the existing local.json lists EXACTLY the manifest's
    /// modules, in order, and every address still has code.
    ///
    /// A file whose list DIFFERS from the manifest is a refusal rather than a
    /// partial top-up: deploying only the new entries would leave a chain whose
    /// contracts were deployed under two different manifests, and nothing
    /// afterwards could tell which. The operator redeploys on a fresh chain or
    /// fixes the manifest; both are one deliberate act.
    /// What the cache says this run must do. Returned as ONE struct: `deploy()`
    /// is at the stack limit, and five separate returns would put it over.
    struct Plan {
        address[] addrs;
        bool[] needsDeploy;
        /// The whole run is already done - nothing to deploy, and any promotion
        /// already written.
        bool done;
    }

    function _plan(
        string memory dir,
        string memory path,
        string memory manifest,
        ModuleSpec[] memory mods,
        address treasury,
        string memory allowFreshDeploy
    ) internal returns (Plan memory plan) {
        // THE CACHE, CHECKED RATHER THAN BELIEVED, and planned PER MODULE.
        //
        // Three outcomes per module, and the third is the one that used to be a
        // bare revert: the derived address is empty, so deploy it; it holds the
        // code this manifest describes, so skip it; or it holds SOMETHING ELSE,
        // which is refused by name with both codehashes rather than failing
        // inside a `new` with no indication of which module or why.
        plan.addrs = new address[](mods.length);
        plan.needsDeploy = new bool[](mods.length);
        bool haveCache = vm.exists(path);
        bool legacyCache = false;
        bool anyToDeploy = false;

        CacheEntry[] memory cached;
        if (haveCache) (cached, legacyCache) = _readCache(path, mods, treasury);

        for (uint256 i = 0; i < mods.length; i++) {
            plan.addrs[i] = _expectedAddress(manifest, i, mods, plan.addrs, treasury);
            if (haveCache && cached[i].addr != plan.addrs[i]) {
                revert(
                    string.concat(
                        "Deploy: ",
                        _cacheKey(mods[i].kind, mods[i].key),
                        " is recorded at ",
                        vm.toString(cached[i].addr),
                        " but this manifest derives ",
                        vm.toString(plan.addrs[i]),
                        " - the file does not describe this deployment"
                    )
                );
            }
            if (plan.addrs[i].code.length == 0) {
                plan.needsDeploy[i] = true;
                anyToDeploy = true;
            } else if (haveCache && !legacyCache && cached[i].codehash != plan.addrs[i].codehash) {
                revert(_foreignCode(mods[i], plan.addrs[i], cached[i].codehash));
            } else if (!haveCache) {
                // No cache and the address is occupied: on a fresh chain this is
                // a squat, and deploying would revert inside `new` with nothing
                // to say which module or why.
                revert(_foreignCode(mods[i], plan.addrs[i], bytes32(0)));
            }
        }

        if (haveCache && !anyToDeploy) {
            if (legacyCache) {
                // A PROMOTION, NOT A PASS. The file verified by derivation and
                // treasury, so it describes this deployment - it just predates
                // codehashes. Rewriting it means the NEXT run can make the
                // stronger check, and says so rather than silently upgrading.
                console.log("Deploy: local.json verified and rewritten with codehashes");
                _writeDeployment(dir, path, mods, plan.addrs, treasury);
                plan.done = true;
                return plan;
            }
            console.log("Deploy: local.json matches the manifest and every address has code - nothing to do");
            plan.done = true;
            return plan;
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
        // directly. THE DEPLOYER'S NONCE USED TO STAND IN FOR IT, and that is
        // what this replaces.
        //
        // The nonce answered a weaker question - has this account transacted
        // here - and it answered it WRONG IN BOTH DIRECTIONS. A fresh chain
        // whose deployer had done anything at all (a funding transfer, a
        // probe, a previous run that reverted after its first transaction)
        // refused a deployment that was perfectly safe. And a chain deployed
        // from a DIFFERENT key read as untouched, because the nonce it checked
        // was not the nonce that deployed anything - so the one case worth
        // refusing, someone else's modules already live here, sailed through.
        //
        // An inferred signal cannot be made to mean what an operator meant. So
        // this asks the operator instead: ALLOW_FRESH_DEPLOY=1 is a deliberate
        // statement that there is nothing here to orphan. Refusing costs one
        // environment variable; being wrong the other way costs the game its
        // money with no error at all.
        //
        // Conditioned on the FILE BEING ABSENT, not merely on the cache check
        // above failing. Those are different: local.json can be present and
        // point at dead addresses (a wiped chain), which is the forward case
        // and must still redeploy. Guarding on the weaker condition made this
        // fire for that case too - so the message could be false, and, worse,
        // it MASKED the forward guard: a mutant disabling the cache check was
        // caught here instead, which means neither guard was independently
        // tested. Two guards satisfied by one scenario is two guards you have
        // not tested.
        // EXACTLY "1", not any truthy-looking value. A permissive reading is the
        // wrong direction for a flag whose whole job is to be deliberate:
        // `ALLOW_FRESH_DEPLOY=0` meaning "yes" is what a compose file does by
        // accident, and the operator who wrote 0 meant the opposite.
        if (!vm.exists(path) && !_eq(allowFreshDeploy, "1")) {
            revert(
                string.concat(
                    "Deploy: refusing to deploy with no ",
                    path,
                    ". A fresh deployment on a chain that already has modules would orphan them ",
                    "and every balance in them. Restore the file, or set ALLOW_FRESH_DEPLOY=1 to ",
                    "state that this chain has nothing to orphan."
                )
            );
        }

    }

    /// The refusal for an address that holds code this deployment did not put
    /// there. NAMED, with both codehashes, because the alternative is a revert
    /// from inside `new` that says only that a creation failed.
    function _foreignCode(ModuleSpec memory m, address at, bytes32 expected)
        internal
        view
        returns (string memory)
    {
        return string.concat(
            "Deploy: ",
            _cacheKey(m.kind, m.key),
            " derives ",
            vm.toString(at),
            ", which already holds code with codehash ",
            vm.toString(at.codehash),
            expected == bytes32(0)
                ? " and no manifest records it - another deployment is using this address"
                : string.concat("; the manifest records ", vm.toString(expected))
        );
    }

    /// The address this manifest WOULD produce for module `i`, derived rather
    /// than read: `saltFor` + the keccak of the init code + the canonical
    /// CREATE2 deployer.
    ///
    /// This is what makes local.json a cache. Every fact in that file is now
    /// checkable against the manifest and the compiled artefacts, so an edited,
    /// copied or hand-written file cannot name an address this deployment could
    /// not have produced - which is what it could do when the address was simply
    /// believed.
    ///
    // `addrs` carries the EARLIER modules' addresses, for a custom contract
    // whose constructor references one by @key. Forward references are already
    // refused when the manifest is read, so by the time module i is derived
    // every address it can name is known. (Plain comments: solc reads `@key` in
    // a doc block as a natspec tag and refuses the file.)
    function _expectedAddress(
        string memory json,
        uint256 i,
        ModuleSpec[] memory mods,
        address[] memory addrs,
        address treasury
    ) internal returns (address) {
        bytes memory initcode;
        bytes32 salt;
        if (_eq(mods[i].kind, KIND_TOKEN)) {
            initcode = abi.encodePacked(
                type(Token).creationCode, abi.encode(mods[i].name, mods[i].symbol, treasury)
            );
            salt = saltFor(mods[i].kind, mods[i].key);
        } else if (_eq(mods[i].kind, KIND_NAMES)) {
            initcode = abi.encodePacked(type(NameRegistry).creationCode, abi.encode(treasury));
            salt = saltFor(mods[i].kind, "");
        } else if (_eq(mods[i].kind, KIND_CONVERTER)) {
            initcode = abi.encodePacked(type(Converter).creationCode, abi.encode(treasury));
            salt = saltFor(KIND_CONVERTER, "");
        } else {
            initcode = abi.encodePacked(
                vm.getCode(string.concat(mods[i].name, ".sol:", mods[i].name)),
                _encodeContractArgs(json, i, mods, addrs, treasury)
            );
            salt = saltFor(KIND_CONTRACT, mods[i].key);
        }
        return vm.computeCreate2Address(salt, keccak256(initcode), CREATE2_DEPLOYER);
    }

    /// Reads the cache and checks everything about it that does not need the
    /// manifest's init code: the chain it was written for, the treasury that
    /// wrote it, and that it describes exactly the modules being asked for.
    ///
    /// LOCAL.JSON IS A CACHE, NOT AN AUTHORITY. Everything here used to be
    /// taken on trust: the file said an address and the script believed it,
    /// checking only that SOMETHING had code there. So a file edited by hand,
    /// copied from another deployment, or written for another chain was
    /// indistinguishable from one this script produced - and the script would
    /// wire a game's money to whatever it named.
    ///
    /// Reverts on every mismatch rather than returning false: a cache that
    /// disagrees with the manifest is not a reason to redeploy silently, it is
    /// a question for whoever wrote one of them.
    function _readCache(string memory path, ModuleSpec[] memory mods, address treasury)
        internal
        view
        returns (CacheEntry[] memory entries, bool legacy)
    {
        string memory json = vm.readFile(path);

        // THE CHAIN IT WAS WRITTEN FOR. A manifest from another chain names
        // addresses that mean nothing here - and on a chain where those
        // addresses happen to hold code, means something worse than nothing.
        uint256 recordedChain = vm.parseJsonUint(json, ".chainId");
        if (recordedChain != block.chainid) {
            revert(
                string.concat(
                    "Deploy: ",
                    path,
                    " was written for chain ",
                    vm.toString(recordedChain),
                    "; this is chain ",
                    vm.toString(block.chainid)
                )
            );
        }

        // THE TREASURY THAT WROTE IT. A rotated deployer key is a different
        // treasury: the recorded modules' admin roles are held by the OLD one,
        // so continuing would produce a deployment nobody present can administer.
        address recordedTreasury = vm.parseJsonAddress(json, ".treasury");
        if (recordedTreasury != treasury) {
            revert(
                string.concat(
                    "Deploy: ",
                    path,
                    " was written by treasury ",
                    vm.toString(recordedTreasury),
                    "; this deployer is ",
                    vm.toString(treasury),
                    " - the recorded modules' roles belong to the old key"
                )
            );
        }

        uint256 n = 0;
        while (vm.keyExistsJson(json, string.concat(".modules[", vm.toString(n), "]"))) {
            n++;
        }

        string memory declared = "";
        entries = new CacheEntry[](n);
        legacy = false;
        for (uint256 i = 0; i < n; i++) {
            string memory at = string.concat(".modules[", vm.toString(i), "]");
            string memory kind = vm.parseJsonString(json, string.concat(at, ".kind"));
            string memory key = vm.keyExistsJson(json, string.concat(at, ".key"))
                ? vm.parseJsonString(json, string.concat(at, ".key"))
                : "";
            declared = string.concat(declared, i == 0 ? "" : ",", _cacheKey(kind, key));

            entries[i].addr = vm.parseJsonAddress(json, string.concat(at, ".address"));
            if (vm.keyExistsJson(json, string.concat(at, ".codehash"))) {
                entries[i].codehash = vm.parseJsonBytes32(json, string.concat(at, ".codehash"));
            } else {
                // A FILE FROM BEFORE CODEHASHES WERE RECORDED. Verified by
                // address derivation and treasury like any other, then rewritten
                // WITH codehashes - a promotion, not a pass.
                legacy = true;
            }
        }

        string memory asked = "";
        for (uint256 i = 0; i < mods.length; i++) {
            asked = string.concat(asked, i == 0 ? "" : ",", _cacheKey(mods[i].kind, mods[i].key));
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
            bool isNames = _eq(mods[i].kind, KIND_NAMES);
            bool isContract = _eq(mods[i].kind, KIND_CONTRACT);
            // A custom contract records its own Solidity name; the fixed kinds
            // record their fixed contract.
            string memory contractName =
                isToken ? CONTRACT_TOKEN : isNames ? CONTRACT_NAMES : isContract ? mods[i].name : CONTRACT_CONVERTER;
            // THE RUNTIME CODEHASH, recorded at write time so the skip path can
            // ask whether the code at that address is still the code this
            // manifest describes. Without it "the address has code" was the
            // whole check, and ANY code passed it - including a different
            // contract that happened to be deployed there first.
            string memory entry = string.concat(
                '{"kind":"',
                mods[i].kind,
                (isToken || isContract) ? string.concat('","key":"', mods[i].key) : "",
                '","contract":"',
                contractName,
                '","address":"',
                vm.toString(addrs[i]),
                '","codehash":"',
                vm.toString(addrs[i].codehash),
                '"',
                isNames ? string.concat(',"tld":"', mods[i].tld, '"') : "",
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
        // WRITTEN AS `.pending`, PROMOTED BY THE CALLER ON SUCCESS.
        //
        // `forge script` runs the whole thing in SIMULATION first, and will run
        // it in simulation ALONE when `--broadcast` is absent. A simulated run
        // computes real addresses from real init code and then mines nothing -
        // so writing local.json here meant a simulation could hand every
        // service downstream a manifest of contracts that do not exist, with no
        // error anywhere and nothing to distinguish it from a real deploy.
        //
        // The script cannot tell the two apart from inside. The caller can: the
        // broadcast's exit status is the fact, and `docker/deploy-once.sh` moves
        // this file into place only when that status is zero.
        vm.writeJson(out, string.concat(path, ".pending"));
        console.log("Deploy: wrote", string.concat(path, ".pending"));
    }
}
