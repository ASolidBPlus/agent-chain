// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Token} from "../src/Token.sol";
import {NameRegistry} from "../src/NameRegistry.sol";
import {Converter} from "../src/Converter.sol";

/// The deploy script, driven end to end inside `forge test` - no live Anvil, no
/// compose, no shell.
///
/// EACH CASE GETS ITS OWN DIRECTORY, named for the case AND for the run. The
/// idempotency guard reads local.json out of that directory, so a case whose
/// assertion reverts before cleanup would otherwise leave state the NEXT run
/// reads as its own. `deployments/.gitignore` ignores `test-*/` for the same
/// reason: the leftovers of a failing run are the normal case while developing,
/// not the edge one.
contract DeployTest is Test {
    uint256 internal constant KEY = 0xA11CE;
    address internal treasury;
    uint256 internal runId;

    function setUp() public {
        treasury = vm.addr(KEY);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(KEY));
        runId = block.timestamp;
    }

    function _dir(string memory name) internal returns (string memory) {
        string memory d = string.concat("../deployments/test-", name, "-", vm.toString(runId));
        vm.createDir(d, true);
        return d;
    }

    function _write(string memory dir, string memory manifest) internal {
        vm.writeFile(string.concat(dir, "/manifest.json"), manifest);
    }

    function _clean(string memory dir) internal {
        vm.removeFile(string.concat(dir, "/manifest.json"));
        if (vm.exists(string.concat(dir, "/local.json"))) vm.removeFile(string.concat(dir, "/local.json"));
        vm.removeDir(dir, true);
    }

    function _example(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat("../deployments/examples/", name));
    }

    /// Constructed BEFORE any `vm.expectRevert`, never inline with it.
    /// `expectRevert` applies to the next CALL, and `new Deploy()` is a CREATE
    /// - so `vm.expectRevert(...); new Deploy().deploy(...)` arms the
    /// expectation against the constructor, the constructor does not revert,
    /// and every refusal case fails with "next call did not revert as
    /// expected" while the refusal it was testing works perfectly.
    function _script() internal returns (Deploy) {
        return new Deploy();
    }

    // ── the four shipped examples ───────────────────────────────────────────

    function test_TokenAndNames() public {
        string memory dir = _dir("token-and-names");
        _write(dir, _example("token-and-names.json"));

        Deploy d = _script();
        d.deploy(dir, "");

        string memory out = vm.readFile(string.concat(dir, "/local.json"));
        assertEq(vm.parseJsonUint(out, ".schema"), 1);
        assertEq(vm.parseJsonUint(out, ".chainId"), block.chainid);
        assertEq(vm.parseJsonAddress(out, ".treasury"), treasury);

        assertEq(vm.parseJsonString(out, ".modules[0].kind"), "token");
        assertEq(vm.parseJsonString(out, ".modules[0].key"), "play");
        assertEq(vm.parseJsonString(out, ".modules[0].contract"), "Token");
        assertEq(vm.parseJsonString(out, ".modules[1].kind"), "names");
        assertEq(vm.parseJsonString(out, ".modules[1].contract"), "NameRegistry");
        assertEq(vm.parseJsonString(out, ".modules[1].tld"), "play");

        Token t = Token(vm.parseJsonAddress(out, ".modules[0].address"));
        assertEq(t.name(), "Play Token");
        assertEq(t.symbol(), "PLAY");
        assertEq(t.balanceOf(treasury), 1_000_000 ether);
        assertFalse(t.hasRole(t.BURNER_ROLE(), treasury));

        NameRegistry r = NameRegistry(vm.parseJsonAddress(out, ".modules[1].address"));
        assertEq(r.resolve("treasury.play"), treasury);

        _clean(dir);
    }

    function test_TokenOnly() public {
        string memory dir = _dir("token-only");
        _write(dir, _example("token-only.json"));

        Deploy d = _script();
        d.deploy(dir, "");

        string memory out = vm.readFile(string.concat(dir, "/local.json"));
        assertEq(vm.parseJsonString(out, ".modules[0].kind"), "token");
        assertFalse(vm.keyExistsJson(out, ".modules[1]"));

        _clean(dir);
    }

    /// A names-only deployment registers NOTHING: `treasury.<tld>` names the
    /// treasury for a token's benefit, and there is no token.
    function test_NamesOnlyRegistersNoTreasuryName() public {
        string memory dir = _dir("names-only");
        _write(dir, _example("names-only.json"));

        Deploy d = _script();
        d.deploy(dir, "");

        string memory out = vm.readFile(string.concat(dir, "/local.json"));
        assertEq(vm.parseJsonString(out, ".modules[0].kind"), "names");
        assertFalse(vm.keyExistsJson(out, ".modules[1]"));

        NameRegistry r = NameRegistry(vm.parseJsonAddress(out, ".modules[0].address"));
        assertEq(r.resolve("treasury.play"), address(0));

        _clean(dir);
    }

    function test_TwoTokensDeployBothAndSeedIndependently() public {
        string memory dir = _dir("two-tokens");
        _write(dir, _example("two-tokens.json"));

        Deploy d = _script();
        d.deploy(dir, "");

        string memory out = vm.readFile(string.concat(dir, "/local.json"));
        assertEq(vm.parseJsonString(out, ".modules[0].key"), "play");
        assertEq(vm.parseJsonString(out, ".modules[1].key"), "gold");
        assertEq(vm.parseJsonString(out, ".modules[2].kind"), "names");

        Token play = Token(vm.parseJsonAddress(out, ".modules[0].address"));
        Token gold = Token(vm.parseJsonAddress(out, ".modules[1].address"));
        assertEq(play.balanceOf(treasury), 1_000_000 ether);
        // initialSupply "0" means the token exists and holds nothing, which is
        // a different state from "not deployed" and the one increment 4 needs.
        assertEq(gold.balanceOf(treasury), 0);
        assertEq(gold.totalSupply(), 0);
        assertEq(gold.symbol(), "GOLD");

        _clean(dir);
    }

    // ── deterministic addresses ─────────────────────────────────────────────

    /// WHICH DEPLOYER the CREATE2 address derives from, MEASURED, because the
    /// obvious reading is wrong.
    ///
    /// `new X{salt: s}(...)` reads like a CREATE2 from the enclosing contract,
    /// and that is what I expected inside `forge test` - the script contract is
    /// just a contract there, with no broadcast to rewrite. It is not what
    /// happens: forge routes salted creation through the canonical CREATE2
    /// deployer in tests too. Measured, all three candidates computed side by
    /// side, and the deployed address matched only this one:
    ///
    ///     actual                 0x3B5228AF…
    ///     from script contract   0x38732cf2…   <- the expected answer, wrong
    ///     from CREATE2 deployer  0x3B5228AF…   <- the measured answer
    ///     from test contract     0x5DbFa66e…
    ///
    /// So the address is the same in `forge test` and under
    /// `forge script --broadcast`, which is what makes the determinism property
    /// testable here at all.
    function test_AddressesAreCreate2FromTheSaltAndInitCode() public {
        string memory dir = _dir("create2");
        _write(dir, _example("token-and-names.json"));
        Deploy d = _script();
        d.deploy(dir, "");

        string memory out = vm.readFile(string.concat(dir, "/local.json"));
        address token = vm.parseJsonAddress(out, ".modules[0].address");
        address registry = vm.parseJsonAddress(out, ".modules[1].address");

        // Anvil predeploys this, measured present on a fresh node.
        address CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        bytes memory tokenInit =
            abi.encodePacked(type(Token).creationCode, abi.encode("Play Token", "PLAY", treasury));
        bytes memory registryInit = abi.encodePacked(type(NameRegistry).creationCode, abi.encode(treasury));

        assertEq(token, vm.computeCreate2Address(d.saltFor("token", "play"), keccak256(tokenInit), CREATE2_DEPLOYER));
        assertEq(
            registry, vm.computeCreate2Address(d.saltFor("names", ""), keccak256(registryInit), CREATE2_DEPLOYER)
        );

        _clean(dir);
    }

    /// THE PROPERTY THE RULING IS ACTUALLY FOR: the same manifest deployed
    /// twice, against two fresh chains, puts each module at the same address.
    ///
    /// `vm.createSelectFork` is not available here, so the two chains are two
    /// `vm.revertTo` snapshots - a fresh state each time, which is what "fresh
    /// chain" means for this property. The deploying contract is held constant
    /// with `vm.etch`, because under `forge script` it is the fixed CREATE2
    /// deployer and a test that let it vary would be measuring the test's own
    /// nonce rather than the ruling.
    function test_TheSameManifestTwiceGivesTheSameAddresses() public {
        string memory dirA = _dir("determinism-a");
        _write(dirA, _example("token-and-names.json"));
        Deploy d = _script();

        uint256 snap = vm.snapshotState();
        d.deploy(dirA, "");
        string memory first = vm.readFile(string.concat(dirA, "/local.json"));
        address tokenA = vm.parseJsonAddress(first, ".modules[0].address");
        address registryA = vm.parseJsonAddress(first, ".modules[1].address");
        vm.removeFile(string.concat(dirA, "/local.json"));

        vm.revertToState(snap);

        d.deploy(dirA, "");
        string memory second = vm.readFile(string.concat(dirA, "/local.json"));
        assertEq(vm.parseJsonAddress(second, ".modules[0].address"), tokenA);
        assertEq(vm.parseJsonAddress(second, ".modules[1].address"), registryA);

        _clean(dirA);
    }

    // ── refusals ────────────────────────────────────────────────────────────

    function test_AbsentManifestIsARefusal() public {
        string memory dir = _dir("absent");
        Deploy d = _script();
        vm.expectRevert(bytes(string.concat("Deploy: manifest: none found at ", dir, "/manifest.json; a deployment must declare its modules")));
        d.deploy(dir, "");
        vm.removeDir(dir, true);
    }

    function test_UnsupportedSchemaIsARefusal() public {
        string memory dir = _dir("schema");
        _write(dir, '{"schema":2,"modules":[{"kind":"names","tld":"play"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest schema 2 unsupported"));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_EmptyModulesIsARefusal() public {
        string memory dir = _dir("empty");
        _write(dir, '{"schema":1,"modules":[]}');
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: at least one module is required"));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_UnknownKindIsARefusal() public {
        string memory dir = _dir("kind");
        _write(dir, '{"schema":1,"modules":[{"kind":"oracle"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: unknown kind "oracle"'));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_DuplicateKeyIsARefusal() public {
        string memory dir = _dir("dupkey");
        _write(
            dir,
            '{"schema":1,"modules":[{"kind":"token","key":"play","name":"A","symbol":"AAA"},{"kind":"token","key":"play","name":"B","symbol":"BBB"}]}'
        );
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: duplicate key "play"'));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_DuplicateSymbolIsARefusal() public {
        string memory dir = _dir("dupsym");
        _write(
            dir,
            '{"schema":1,"modules":[{"kind":"token","key":"a","name":"A","symbol":"PLAY"},{"kind":"token","key":"b","name":"B","symbol":"PLAY"}]}'
        );
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: duplicate symbol "PLAY"'));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_TwoNamesModulesIsARefusal() public {
        string memory dir = _dir("twonames");
        _write(dir, '{"schema":1,"modules":[{"kind":"names","tld":"a"},{"kind":"names","tld":"b"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: more than one names module"));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_InvalidSymbolIsARefusal() public {
        string memory dir = _dir("badsym");
        _write(dir, '{"schema":1,"modules":[{"kind":"token","key":"play","name":"A","symbol":"play"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: token "play" has an invalid symbol'));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_InvalidInitialSupplyIsARefusal() public {
        string memory dir = _dir("badsupply");
        _write(dir, '{"schema":1,"modules":[{"kind":"token","key":"play","name":"A","symbol":"AAA","initialSupply":"1.5"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: token "play" has an invalid initialSupply'));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_InvalidTldIsARefusal() public {
        string memory dir = _dir("badtld");
        _write(dir, '{"schema":1,"modules":[{"kind":"names","tld":"PLAY"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: names module has an invalid tld"));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_RetiredEnvIsARefusal() public {
        string memory dir = _dir("retired");
        _write(dir, _example("token-only.json"));
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: INITIAL_SUPPLY_VEE is retired; put initialSupply in the manifest"));
        d.deploy(dir, "1000");
        _clean(dir);
    }

    // ── idempotency ─────────────────────────────────────────────────────────

    /// The whole reason this script is safe to run on every container start.
    function test_SecondRunWithTheSameManifestDeploysNothingNew() public {
        string memory dir = _dir("idem");
        _write(dir, _example("token-and-names.json"));

        Deploy d = _script();
        d.deploy(dir, "");
        string memory first = vm.readFile(string.concat(dir, "/local.json"));
        address firstToken = vm.parseJsonAddress(first, ".modules[0].address");

        d.deploy(dir, "");
        string memory second = vm.readFile(string.concat(dir, "/local.json"));
        assertEq(vm.parseJsonAddress(second, ".modules[0].address"), firstToken);

        _clean(dir);
    }

    /// A local.json whose module list differs from the manifest is a REFUSAL,
    /// never a partial top-up: a chain whose contracts came from two different
    /// manifests is one nothing afterwards can describe.
    function test_ADifferentModuleListIsARefusal() public {
        string memory dir = _dir("mismatch");
        _write(dir, _example("token-and-names.json"));
        Deploy d = _script();
        d.deploy(dir, "");

        _write(dir, _example("token-only.json"));
        d = _script();
        vm.expectRevert(
            bytes("Deploy: local.json declares modules play,names; manifest asks for play - redeploy on a fresh chain or fix the manifest")
        );
        d.deploy(dir, "");

        _clean(dir);
    }

    // ── the converter (increment 4) ───────────────────────────────────────────

    function test_ConverterDeploysWithItsPairsAndGrants() public {
        string memory dir = _dir("converter");
        _write(dir, _example("two-tokens.json"));

        Deploy d = _script();
        d.deploy(dir, "");

        string memory out = vm.readFile(string.concat(dir, "/local.json"));
        assertEq(vm.parseJsonString(out, ".modules[3].kind"), "converter");
        assertEq(vm.parseJsonString(out, ".modules[3].contract"), "Converter");
        assertFalse(vm.keyExistsJson(out, ".modules[3].tld"), "converter entry must not carry a tld");
        assertFalse(vm.keyExistsJson(out, ".modules[3].pairs"), "pairs are read from the contract, not local.json");

        Token play = Token(vm.parseJsonAddress(out, ".modules[0].address"));
        Token gold = Token(vm.parseJsonAddress(out, ".modules[1].address"));
        Converter c = Converter(vm.parseJsonAddress(out, ".modules[3].address"));

        (uint256 rateFwd,, bool existsFwd) = c.pair(address(play), address(gold));
        (uint256 rateBack,, bool existsBack) = c.pair(address(gold), address(play));
        assertTrue(existsFwd && existsBack, "both pairs exist");
        assertEq(rateFwd, 0.75e18);
        assertEq(rateBack, 1e18);
        assertEq(c.quote(address(play), address(gold), 1e18), 0.75e18);

        // Grants per §1.4: the converter burns each source and mints each target;
        // the treasury keeps MINTER on both and holds BURNER on neither.
        assertTrue(play.hasRole(play.BURNER_ROLE(), address(c)), "converter burns play");
        assertTrue(gold.hasRole(gold.MINTER_ROLE(), address(c)), "converter mints gold");
        assertTrue(gold.hasRole(gold.BURNER_ROLE(), address(c)), "converter burns gold");
        assertTrue(play.hasRole(play.MINTER_ROLE(), address(c)), "converter mints play");
        assertFalse(play.hasRole(play.BURNER_ROLE(), treasury), "treasury must not burn play");
        assertFalse(gold.hasRole(gold.BURNER_ROLE(), treasury), "treasury must not burn gold");

        // The converter's address is CREATE2 from its salt and init code, like
        // every other module (§3). Same canonical deployer as the token/names
        // case above, so the address is the one a real --broadcast produces.
        address CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        bytes memory converterInit = abi.encodePacked(type(Converter).creationCode, abi.encode(treasury));
        assertEq(
            address(c),
            vm.computeCreate2Address(d.saltFor("converter", ""), keccak256(converterInit), CREATE2_DEPLOYER),
            "converter address is not CREATE2 from its salt and init code"
        );

        _clean(dir);
    }

    function test_ConverterLoopingManifestIsARefusal() public {
        string memory dir = _dir("converterloop");
        _write(
            dir,
            '{"schema":1,"modules":['
            '{"kind":"token","key":"play","name":"Play","symbol":"PLAY"},'
            '{"kind":"token","key":"gold","name":"Gold","symbol":"GOLD"},'
            '{"kind":"converter","pairs":['
            '{"source":"play","target":"gold","rate":"0.75"},'
            '{"source":"gold","target":"play","rate":"1.5"}]}'
            ']}'
        );
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: pair play->gold x gold->play mints value"));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_ConverterUnknownTokenKeyIsARefusal() public {
        string memory dir = _dir("convunknown");
        _write(
            dir,
            '{"schema":1,"modules":['
            '{"kind":"token","key":"play","name":"Play","symbol":"PLAY"},'
            '{"kind":"converter","pairs":[{"source":"play","target":"gold","rate":"1"}]}'
            ']}'
        );
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: converter pair target "gold" is not a token key'));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_ConverterSelfPairIsARefusal() public {
        string memory dir = _dir("convself");
        _write(
            dir,
            '{"schema":1,"modules":['
            '{"kind":"token","key":"play","name":"Play","symbol":"PLAY"},'
            '{"kind":"converter","pairs":[{"source":"play","target":"play","rate":"1"}]}'
            ']}'
        );
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: converter pair "play" converts to itself'));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_TwoConverterModulesIsARefusal() public {
        string memory dir = _dir("twoconv");
        _write(
            dir,
            '{"schema":1,"modules":['
            '{"kind":"token","key":"play","name":"Play","symbol":"PLAY"},'
            '{"kind":"token","key":"gold","name":"Gold","symbol":"GOLD"},'
            '{"kind":"converter","pairs":[{"source":"play","target":"gold","rate":"1"}]},'
            '{"kind":"converter","pairs":[{"source":"gold","target":"play","rate":"1"}]}'
            ']}'
        );
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: more than one converter module"));
        d.deploy(dir, "");
        _clean(dir);
    }

    function test_ConverterEmptyPairsIsARefusal() public {
        string memory dir = _dir("convempty");
        _write(
            dir,
            '{"schema":1,"modules":['
            '{"kind":"token","key":"play","name":"Play","symbol":"PLAY"},'
            '{"kind":"converter","pairs":[]}'
            ']}'
        );
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: converter has no pairs"));
        d.deploy(dir, "");
        _clean(dir);
    }

    // ── parseDecimal18, tested directly (§3) ──────────────────────────────────

    function test_ParseDecimal18Accepts() public {
        Deploy d = _script();
        assertEq(d.parseDecimal18("1"), 1e18);
        assertEq(d.parseDecimal18("0.75"), 0.75e18);
        assertEq(d.parseDecimal18("1.5"), 1.5e18);
        assertEq(d.parseDecimal18("0.000000000000000001"), 1);
        assertEq(d.parseDecimal18("2."), 2e18);
    }

    function test_ParseDecimal18RefusesEmptyIntegerPart() public {
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: rate ".5" is not a decimal'));
        d.parseDecimal18(".5");
    }

    function test_ParseDecimal18RefusesMoreThan18Places() public {
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: rate has more than 18 decimal places"));
        d.parseDecimal18("1.0000000000000000001");
    }

    function test_ParseDecimal18RefusesZeroAndOverMax() public {
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: rate must be > 0"));
        d.parseDecimal18("0");
        vm.expectRevert(bytes("Deploy: manifest: rate exceeds MAX_RATE"));
        d.parseDecimal18("1000000000001"); // 1e12 + 1 whole units
    }
}
