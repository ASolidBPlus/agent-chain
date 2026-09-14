// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Token} from "../src/Token.sol";
import {NameRegistry} from "../src/NameRegistry.sol";

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
}
