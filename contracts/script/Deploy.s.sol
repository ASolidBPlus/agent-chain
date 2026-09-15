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
        string memory manifestPath = string.concat(dir, "/manifest.json");

        // Retired rather than ignored. Silently dropping it would leave an
        // operator's supply setting doing nothing with no way to notice.
        if (bytes(retiredSupplyEnv).length > 0) {
            revert("Deploy: INITIAL_SUPPLY_VEE is retired; put initialSupply in the manifest");
        }

        ModuleSpec[] memory mods = _readManifest(manifestPath);
        // Validated up front so a bad converter manifest fails fast, with the
        // readable message, before anything is broadcast.
        ConverterPair[] memory pairs = _readConverterPairs(manifestPath, mods);
        // Custom-contract artifacts are checked before broadcast so a missing one
        // is a readable refusal rather than a raw getCode revert mid-deploy. Their
        // constructor args are read from the manifest at deploy time in
        // _deployContract, where @key references resolve to earlier addresses.
        _requireContractArtifacts(mods);

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

        address[] memory addrs = new address[](mods.length);
        address namesAddr = address(0);
        address converterAddr = address(0);
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
            } else if (_eq(mods[i].kind, KIND_NAMES)) {
                NameRegistry r = new NameRegistry{salt: saltFor(mods[i].kind, "")}(treasury);
                addrs[i] = address(r);
                namesAddr = address(r);
                tld = mods[i].tld;
            } else if (_eq(mods[i].kind, KIND_CONVERTER)) {
                // Converter: deployed with no pairs and no grants yet; both are
                // wired below, once every token address is known. Salted with the
                // bare kind (one converter per deployment) so its address is
                // deterministic like every other module's.
                Converter c = new Converter{salt: saltFor(KIND_CONVERTER, "")}(treasury);
                addrs[i] = address(c);
                converterAddr = address(c);
            } else {
                // A custom contract, deployed by name with static-typed args. Kept
                // in its own function so deploy()'s stack stays within limits.
                // Registered contracts get NO role grants (spec S1.1); any role
                // they need comes later through admin-call.
                addrs[i] = _deployContract(manifestPath, i, mods, addrs, treasury);
            }
        }
        // `treasury.<tld>` names the treasury FOR A TOKEN'S BENEFIT, so it is
        // registered only when the deployment has both. A names-only deployment
        // gets a registry with nothing in it, which is correct: there is no
        // money for the treasury to hold.
        if (namesAddr != address(0) && haveToken) {
            NameRegistry(namesAddr).registerFor(string.concat("treasury.", tld), treasury, treasury);
        }
        // Wire the converter LAST: each pair needs its two token addresses, and
        // the converter is the only holder of BURNER_ROLE on any token. The
        // treasury keeps MINTER_ROLE on every token; the converter is an
        // additional minter on each target, never a replacement.
        if (converterAddr != address(0)) {
            for (uint256 j = 0; j < pairs.length; j++) {
                address src = _tokenAddrByKey(mods, addrs, pairs[j].source);
                address tgt = _tokenAddrByKey(mods, addrs, pairs[j].target);
                Converter(converterAddr).setPair(src, tgt, pairs[j].rate);
                Token(src).grantRole(Token(src).BURNER_ROLE(), converterAddr);
                Token(tgt).grantRole(Token(tgt).MINTER_ROLE(), converterAddr);
            }
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < mods.length; i++) {
            if (_eq(mods[i].kind, KIND_TOKEN)) {
                Token t = Token(addrs[i]);
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
            } else if (_eq(mods[i].kind, KIND_NAMES)) {
                NameRegistry r = NameRegistry(addrs[i]);
                require(r.hasRole(r.REGISTRAR_ROLE(), treasury), "Deploy: treasury lacks REGISTRAR_ROLE");
                if (haveToken) {
                    require(
                        r.resolve(string.concat("treasury.", tld)) == treasury,
                        "Deploy: treasury name does not resolve"
                    );
                }
            } else if (_eq(mods[i].kind, KIND_CONVERTER)) {
                Converter c = Converter(addrs[i]);
                for (uint256 j = 0; j < pairs.length; j++) {
                    address src = _tokenAddrByKey(mods, addrs, pairs[j].source);
                    address tgt = _tokenAddrByKey(mods, addrs, pairs[j].target);
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
                require(addrs[i].code.length > 0, "Deploy: contract has no code");
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
    function _readConverterPairs(string memory manifestPath, ModuleSpec[] memory mods)
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

        string memory json = vm.readFile(manifestPath);
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
        string memory manifestPath,
        uint256 idx,
        ModuleSpec[] memory mods,
        address[] memory addrs,
        address treasury
    ) internal returns (address deployed) {
        string memory json = vm.readFile(manifestPath);
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
            // An entry is identified by its key when it has one (token, contract),
            // else by its kind (the singletons names/converter) - the same
            // effective key _readManifest enforces unique.
            declared = string.concat(
                declared, i == 0 ? "" : ",", (_eq(kind, KIND_TOKEN) || _eq(kind, KIND_CONTRACT)) ? key : kind
            );
        }

        string memory asked = "";
        for (uint256 i = 0; i < mods.length; i++) {
            asked = string.concat(asked, i == 0 ? "" : ",", _effectiveKey(mods[i]));
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
            bool isNames = _eq(mods[i].kind, KIND_NAMES);
            bool isContract = _eq(mods[i].kind, KIND_CONTRACT);
            // A custom contract records its own Solidity name; the fixed kinds
            // record their fixed contract.
            string memory contractName =
                isToken ? CONTRACT_TOKEN : isNames ? CONTRACT_NAMES : isContract ? mods[i].name : CONTRACT_CONVERTER;
            string memory entry = string.concat(
                '{"kind":"',
                mods[i].kind,
                (isToken || isContract) ? string.concat('","key":"', mods[i].key) : "",
                '","contract":"',
                contractName,
                '","address":"',
                vm.toString(addrs[i]),
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
