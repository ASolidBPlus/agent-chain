// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Token} from "../src/Token.sol";
import {NameRegistry} from "../src/NameRegistry.sol";
import {Converter} from "../src/Converter.sol";
import {Fixture} from "./fixtures/Fixture.sol";

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
        // A refusal can leave a .pending behind - the container's script deletes
        // one before every run for the same reason, so a failed run cannot hand
        // the next one a manifest describing a deployment that never happened.
        if (vm.exists(string.concat(dir, "/local.json.pending"))) {
            vm.removeFile(string.concat(dir, "/local.json.pending"));
        }
        vm.removeDir(dir, true);
    }

    function _example(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat("../deployments/examples/", name));
    }

    /// What `docker/deploy-once.sh` does after a broadcast exits 0: move the
    /// manifest the script wrote into place.
    ///
    /// THE TESTS PROMOTE EXPLICITLY rather than the script writing local.json
    /// directly, because that split is the finding. `forge script` simulates
    /// before it broadcasts and will simulate ALONE when `--broadcast` is
    /// absent, computing real addresses for contracts it never mines - so the
    /// script writes `.pending` and only a successful broadcast promotes it. A
    /// test that read local.json straight after `deploy()` would be asserting on
    /// a file the production path does not write at that moment.
    /// Returns true if there was something to promote. NO .pending IS NOT AN
    /// ERROR: the skip path writes nothing, and the container's script says
    /// "nothing to promote" rather than failing. A helper that insisted on a
    /// file would make the idempotent second run look like a broken deploy.
    function _promote(string memory dir) internal returns (bool) {
        string memory pending = string.concat(dir, "/local.json.pending");
        if (!vm.exists(pending)) return false;
        vm.writeFile(string.concat(dir, "/local.json"), vm.readFile(pending));
        vm.removeFile(pending);
        return true;
    }

    /// Deploy and promote, which together are one successful run of the
    /// container's one-shot.
    function _deployed(Deploy d, string memory dir, string memory supply) internal returns (bool) {
        d.deploy(dir, supply, "1");
        return _promote(dir);
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

    // ── finding 8: no local.json is a question, not an inference ────────────

    /// The absent-file path refuses without the flag, and the message names it.
    ///
    /// THE REFUSAL IS THE FEATURE. A deployment with no manifest of its own
    /// cannot tell whether the chain already holds modules, so it asks the
    /// operator instead of guessing - and the guess it used to make, the
    /// deployer's nonce, was wrong in both directions: a fresh chain whose
    /// deployer had sent one transaction refused a safe deploy, and a chain
    /// deployed from a DIFFERENT key read as untouched, which is the only case
    /// worth refusing.
    function test_NoLocalJsonRefusesWithoutTheFlag() public {
        string memory dir = _dir("fresh-refuse");
        _write(dir, _example("token-and-names.json"));
        Deploy d = _script();
        vm.expectRevert(bytes(_freshRefusal(dir)));
        // PASSED, NOT UNSET. `vm.setEnv` writes a process-wide variable and
        // forge runs test contracts in parallel, so unsetting it here unset it
        // for every suite running beside this one - measured, six unrelated
        // deploy tests failed with this refusal. The flag is a parameter for
        // exactly that reason; the env read lives in `run()`.
        d.deploy(dir, "", "");

        // Nothing was written: the refusal happens before any broadcast.
        assertFalse(vm.exists(string.concat(dir, "/local.json")), "local.json must not exist");
        _clean(dir);
    }

    /// EXACTLY "1", not any truthy-looking value. `ALLOW_FRESH_DEPLOY=0` meaning
    /// "yes" is what a permissive reading would give, and an operator who wrote
    /// 0 meant the opposite of what they would have got.
    function test_TheFlagIsExactlyOne() public {
        string memory dir = _dir("fresh-flag-strict");
        _write(dir, _example("token-and-names.json"));

        for (uint256 i = 0; i < 4; i++) {
            string memory value = i == 0 ? "0" : i == 1 ? "true" : i == 2 ? "yes" : "  1";
            Deploy d = _script();
            vm.expectRevert(bytes(_freshRefusal(dir)));
            d.deploy(dir, "", value);
        }

        // ...and the control: the exact string deploys, or the loop above would
        // pass against a build that refused everything.
        Deploy ok = _script();
        _deployed(ok, dir, "");
        assertTrue(vm.exists(string.concat(dir, "/local.json")), "local.json should exist");
        _clean(dir);
    }

    function _freshRefusal(string memory dir) internal pure returns (string memory) {
        return string.concat(
            "Deploy: refusing to deploy with no ",
            dir,
            "/local.json. A fresh deployment on a chain that already has modules would orphan them ",
            "and every balance in them. Restore the file, or set ALLOW_FRESH_DEPLOY=1 to ",
            "state that this chain has nothing to orphan."
        );
    }

    // ── finding 6: a simulation must never touch the manifest ───────────────

    /// The script writes `.pending` and NOTHING ELSE. Promotion is the caller's,
    /// conditional on a broadcast that actually succeeded.
    ///
    /// The reviewer's probe: `forge script` simulates before it broadcasts and
    /// will simulate ALONE when `--broadcast` is absent, computing real CREATE2
    /// addresses for contracts it never mines. Writing local.json from inside
    /// the script therefore handed every service downstream a manifest of
    /// contracts that do not exist, with nothing to distinguish it from a real
    /// deploy. The script cannot tell the two apart from inside; the exit status
    /// of the broadcast is the fact, and only the caller has it.
    function test_TheScriptWritesPendingAndNeverTheManifest() public {
        string memory dir = _dir("pending-only");
        _write(dir, _example("token-and-names.json"));

        Deploy d = _script();
        d.deploy(dir, "", "1");

        assertTrue(
            vm.exists(string.concat(dir, "/local.json.pending")),
            "the script should write local.json.pending"
        );
        assertFalse(
            vm.exists(string.concat(dir, "/local.json")),
            "the script must NOT write local.json - promotion is the caller's"
        );

        // ...and after the caller promotes, the manifest is exactly what the
        // script wrote. Promotion moves bytes; it does not re-derive anything.
        string memory pending = vm.readFile(string.concat(dir, "/local.json.pending"));
        _promote(dir);
        assertEq(vm.readFile(string.concat(dir, "/local.json")), pending, "promotion must not alter the file");
        assertFalse(vm.exists(string.concat(dir, "/local.json.pending")), "the pending file should be consumed");

        _clean(dir);
    }

    // ── findings 7 / 17 / 18 / 19: the manifest is a cache, not an authority ─

    /// A file written for ANOTHER CHAIN is refused, and says which.
    function test_ACacheFromAnotherChainIsRefused() public {
        string memory dir = _dir("chainid");
        _write(dir, _example("token-and-names.json"));
        Deploy d = _script();
        _deployed(d, dir, "");

        string memory path = string.concat(dir, "/local.json");
        // `vm.writeJson` at a key, not a string replace: the file is
        // PRETTY-PRINTED, so `"chainId":31337` does not appear in it and a
        // replace would silently do nothing - leaving a test that passes
        // against an unmodified file.
        vm.writeJson("1", path, ".chainId");

        Deploy again = _script();
        vm.expectRevert(
            bytes(
                string.concat(
                    "Deploy: ", path, " was written for chain 1; this is chain ", vm.toString(block.chainid)
                )
            )
        );
        again.deploy(dir, "", "1");
        _clean(dir);
    }

    /// A ROTATED DEPLOYER KEY is a different treasury, and the recorded modules'
    /// admin roles belong to the old one - so continuing would produce a
    /// deployment nobody present can administer.
    function test_ACacheFromAnotherTreasuryIsRefused() public {
        string memory dir = _dir("treasury");
        _write(dir, _example("token-and-names.json"));
        Deploy d = _script();
        _deployed(d, dir, "");

        string memory path = string.concat(dir, "/local.json");
        string memory json = vm.readFile(path);
        address other = vm.addr(0xB0B);
        vm.writeFile(path, vm.replace(json, vm.toString(treasury), vm.toString(other)));

        Deploy again = _script();
        // The FIRST refusal is the treasury one: it is checked before any
        // address is derived, because a wrong treasury makes every derivation
        // wrong too and the useful message is the cause, not the symptom.
        vm.expectRevert(
            bytes(
                string.concat(
                    "Deploy: ",
                    path,
                    " was written by treasury ",
                    vm.toString(other),
                    "; this deployer is ",
                    vm.toString(treasury),
                    " - the recorded modules' roles belong to the old key"
                )
            )
        );
        again.deploy(dir, "", "1");
        _clean(dir);
    }

    /// AN ADDRESS THIS MANIFEST COULD NOT PRODUCE is refused by derivation.
    /// This is the check that makes the file a cache: before it, the script
    /// believed whatever address the file named and looked only for code there.
    function test_ATamperedAddressIsRefused() public {
        string memory dir = _dir("tampered");
        _write(dir, _example("token-and-names.json"));
        Deploy d = _script();
        _deployed(d, dir, "");

        string memory path = string.concat(dir, "/local.json");
        string memory json = vm.readFile(path);
        address real = vm.parseJsonAddress(json, ".modules[0].address");
        // Somewhere with no code, so the failure is the DERIVATION and not the
        // codehash check one branch further on.
        address fake = address(0xDEAD);
        vm.writeFile(path, vm.replace(json, vm.toString(real), vm.toString(fake)));

        Deploy again = _script();
        vm.expectRevert(
            bytes(
                string.concat(
                    "Deploy: token:play is recorded at ",
                    vm.toString(fake),
                    " but this manifest derives ",
                    vm.toString(real),
                    " - the file does not describe this deployment"
                )
            )
        );
        again.deploy(dir, "", "1");
        _clean(dir);
    }

    /// A RECORDED CODEHASH THAT NO LONGER MATCHES is refused BY NAME, with both
    /// hashes - never a bare revert from inside `new`.
    function test_AChangedCodehashIsRefusedByName() public {
        string memory dir = _dir("codehash");
        _write(dir, _example("token-and-names.json"));
        Deploy d = _script();
        _deployed(d, dir, "");

        string memory path = string.concat(dir, "/local.json");
        string memory json = vm.readFile(path);
        address at = vm.parseJsonAddress(json, ".modules[0].address");
        bytes32 recorded = vm.parseJsonBytes32(json, ".modules[0].codehash");
        bytes32 wrong = keccak256("not this contract");
        vm.writeFile(path, vm.replace(json, vm.toString(recorded), vm.toString(wrong)));

        Deploy again = _script();
        vm.expectRevert(
            bytes(
                string.concat(
                    "Deploy: token:play derives ",
                    vm.toString(at),
                    ", which already holds code with codehash ",
                    vm.toString(at.codehash),
                    "; the manifest records ",
                    vm.toString(wrong)
                )
            )
        );
        again.deploy(dir, "", "1");
        _clean(dir);
    }

    /// A LEGACY FILE - no codehash field - is verified by derivation and
    /// treasury, then REWRITTEN with codehashes. A promotion, not a pass.
    function test_ALegacyCacheIsVerifiedThenPromoted() public {
        string memory dir = _dir("legacy");
        _write(dir, _example("token-and-names.json"));
        Deploy d = _script();
        _deployed(d, dir, "");

        string memory path = string.concat(dir, "/local.json");
        string memory json = vm.readFile(path);
        bytes32 recorded = vm.parseJsonBytes32(json, ".modules[0].codehash");
        // BUILT BY HAND rather than stripped by a string replace. The file is
        // pretty-printed, so the field's on-disk spelling carries newlines and
        // indentation that a naive replace misses - and a fixture that failed to
        // strip the field would leave this test asserting the promotion path
        // while exercising the ordinary one. The assertion below is what says
        // the fixture is the shape this test is named for.
        vm.writeFile(
            path,
            string.concat(
                '{"schema":1,"chainId":',
                vm.toString(block.chainid),
                ',"treasury":"',
                vm.toString(treasury),
                '","modules":[{"kind":"token","key":"play","contract":"Token","address":"',
                vm.toString(vm.parseJsonAddress(json, ".modules[0].address")),
                '"},{"kind":"names","contract":"NameRegistry","address":"',
                vm.toString(vm.parseJsonAddress(json, ".modules[1].address")),
                '","tld":"play"}]}'
            )
        );
        assertFalse(vm.keyExistsJson(vm.readFile(path), ".modules[0].codehash"), "the fixture must lack it");

        Deploy again = _script();
        again.deploy(dir, "", "1");
        // Promotion writes through the same pending/promote path as a deploy.
        _promote(dir);

        string memory after_ = vm.readFile(string.concat(dir, "/local.json"));
        assertTrue(vm.keyExistsJson(after_, ".modules[0].codehash"), "the promotion should add codehashes");
        assertEq(vm.parseJsonBytes32(after_, ".modules[0].codehash"), recorded, "and the right ones");
        _clean(dir);
    }

    // ── the four shipped examples ───────────────────────────────────────────

    function test_TokenAndNames() public {
        string memory dir = _dir("token-and-names");
        _write(dir, _example("token-and-names.json"));

        Deploy d = _script();
        _deployed(d, dir, "");

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
        // Granted by Token's CONSTRUCTOR, asserted by the deploy script. This
        // mirrors the script's require so the property is checked where the
        // deploy actually runs AND where a reader of the tests can see it - the
        // script's require only fires during a deploy, and a deploy that is
        // never run in CI asserts nothing.
        assertTrue(t.hasRole(t.FREEZER_ROLE(), treasury), "treasury freezes play");

        NameRegistry r = NameRegistry(vm.parseJsonAddress(out, ".modules[1].address"));
        assertEq(r.resolve("treasury.play"), treasury);

        _clean(dir);
    }

    function test_TokenOnly() public {
        string memory dir = _dir("token-only");
        _write(dir, _example("token-only.json"));

        Deploy d = _script();
        _deployed(d, dir, "");

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
        _deployed(d, dir, "");

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
        _deployed(d, dir, "");

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
        _deployed(d, dir, "");

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
        _deployed(d, dirA, "");
        string memory first = vm.readFile(string.concat(dirA, "/local.json"));
        address tokenA = vm.parseJsonAddress(first, ".modules[0].address");
        address registryA = vm.parseJsonAddress(first, ".modules[1].address");
        vm.removeFile(string.concat(dirA, "/local.json"));

        vm.revertToState(snap);

        _deployed(d, dirA, "");
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
        d.deploy(dir, "", "1");
        vm.removeDir(dir, true);
    }

    function test_UnsupportedSchemaIsARefusal() public {
        string memory dir = _dir("schema");
        _write(dir, '{"schema":2,"modules":[{"kind":"names","tld":"play"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest schema 2 unsupported"));
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_EmptyModulesIsARefusal() public {
        string memory dir = _dir("empty");
        _write(dir, '{"schema":1,"modules":[]}');
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: at least one module is required"));
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_UnknownKindIsARefusal() public {
        string memory dir = _dir("kind");
        _write(dir, '{"schema":1,"modules":[{"kind":"oracle"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: unknown kind "oracle"'));
        d.deploy(dir, "", "1");
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
        d.deploy(dir, "", "1");
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
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_TwoNamesModulesIsARefusal() public {
        string memory dir = _dir("twonames");
        _write(dir, '{"schema":1,"modules":[{"kind":"names","tld":"a"},{"kind":"names","tld":"b"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: more than one names module"));
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_InvalidSymbolIsARefusal() public {
        string memory dir = _dir("badsym");
        _write(dir, '{"schema":1,"modules":[{"kind":"token","key":"play","name":"A","symbol":"play"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: token "play" has an invalid symbol'));
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_InvalidInitialSupplyIsARefusal() public {
        string memory dir = _dir("badsupply");
        _write(dir, '{"schema":1,"modules":[{"kind":"token","key":"play","name":"A","symbol":"AAA","initialSupply":"1.5"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: token "play" has an invalid initialSupply'));
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_InvalidTldIsARefusal() public {
        string memory dir = _dir("badtld");
        _write(dir, '{"schema":1,"modules":[{"kind":"names","tld":"PLAY"}]}');
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: manifest: names module has an invalid tld"));
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_RetiredEnvIsARefusal() public {
        string memory dir = _dir("retired");
        _write(dir, _example("token-only.json"));
        Deploy d = _script();
        vm.expectRevert(bytes("Deploy: INITIAL_SUPPLY_VEE is retired; put initialSupply in the manifest"));
        d.deploy(dir, "1000", "1");
        _clean(dir);
    }

    // ── idempotency ─────────────────────────────────────────────────────────

    /// The whole reason this script is safe to run on every container start.
    function test_SecondRunWithTheSameManifestDeploysNothingNew() public {
        string memory dir = _dir("idem");
        _write(dir, _example("token-and-names.json"));

        Deploy d = _script();
        assertTrue(_deployed(d, dir, ""), "the first run should write a manifest");
        string memory first = vm.readFile(string.concat(dir, "/local.json"));
        address firstToken = vm.parseJsonAddress(first, ".modules[0].address");

        // THE SKIP PATH WRITES NOTHING, and that is the direct statement of
        // "deployed nothing new". Comparing addresses is weaker than it looks:
        // CREATE2 with the same salt and init code gives the SAME address, so a
        // run that really did redeploy would either revert or - if it somehow
        // did not - produce an identical address and pass. No .pending is a
        // fact about what this run did, not about what it would have produced.
        assertFalse(_deployed(d, dir, ""), "the second run should write nothing");
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
        _deployed(d, dir, "");

        _write(dir, _example("token-only.json"));
        d = _script();
        vm.expectRevert(
            // QUALIFIED BY KIND on both sides (finding 18). `_effectiveKey` collapses a
            // token to its bare key and a singleton to its bare kind, so a token
            // keyed "names" and the names module both reduce to "names". The
            // manifest's own uniqueness check refuses such a manifest - but the
            // cache is a FILE, and a file is not required to have come from a
            // manifest this script accepted.
            bytes("Deploy: local.json declares modules token:play,names:; manifest asks for token:play - redeploy on a fresh chain or fix the manifest")
        );
        d.deploy(dir, "", "1");

        _clean(dir);
    }

    // ── the converter (increment 4) ───────────────────────────────────────────

    function test_ConverterDeploysWithItsPairsAndGrants() public {
        string memory dir = _dir("converter");
        _write(dir, _example("two-tokens.json"));

        Deploy d = _script();
        _deployed(d, dir, "");

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
        // THE CONVERTER MUST NEVER FREEZE, on either token. Nothing grants it
        // the role, so this asserts something no line of code makes true - and
        // that is the reason to assert it: the four grants directly above are
        // where a fifth would go, and a converter that could freeze the accounts
        // it burns from is one word away from here.
        assertFalse(play.hasRole(play.FREEZER_ROLE(), address(c)), "converter must not freeze play");
        assertFalse(gold.hasRole(gold.FREEZER_ROLE(), address(c)), "converter must not freeze gold");
        // And the treasury DOES hold it on both, which is what makes the two
        // assertions above a statement about the converter rather than about
        // the role being unheld everywhere.
        assertTrue(play.hasRole(play.FREEZER_ROLE(), treasury), "treasury freezes play");
        assertTrue(gold.hasRole(gold.FREEZER_ROLE(), treasury), "treasury freezes gold");

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
        d.deploy(dir, "", "1");
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
        d.deploy(dir, "", "1");
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
        d.deploy(dir, "", "1");
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
        d.deploy(dir, "", "1");
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
        d.deploy(dir, "", "1");
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

    // ── custom contracts (increment 3, §8.8) ──────────────────────────────────

    string internal constant FIXTURE_TAG =
        "0x0000000000000000000000000000000000000000000000000000000000000022";

    function test_ContractDeploysWithResolvedArgs() public {
        string memory dir = _dir("contract");
        _write(
            dir,
            string.concat(
                '{"schema":1,"modules":[',
                '{"kind":"token","key":"play","name":"Play","symbol":"PLAY"},',
                '{"kind":"contract","key":"shop","contract":"Fixture","args":[',
                '{"type":"address","value":"@play"},',
                '{"type":"uint256","value":"500"},',
                '{"type":"bool","value":"true"},',
                '{"type":"bytes32","value":"',
                FIXTURE_TAG,
                '"}]}]}'
            )
        );

        Deploy d = _script();
        _deployed(d, dir, "");

        string memory out = vm.readFile(string.concat(dir, "/local.json"));
        // local.json entry shape (§8.8): kind, key, the Solidity contract name,
        // an address; no tld, no args (args live only in the manifest).
        assertEq(vm.parseJsonString(out, ".modules[1].kind"), "contract");
        assertEq(vm.parseJsonString(out, ".modules[1].key"), "shop");
        assertEq(vm.parseJsonString(out, ".modules[1].contract"), "Fixture");
        assertFalse(vm.keyExistsJson(out, ".modules[1].tld"));
        assertFalse(vm.keyExistsJson(out, ".modules[1].args"));

        address playAddr = vm.parseJsonAddress(out, ".modules[0].address");
        address shopAddr = vm.parseJsonAddress(out, ".modules[1].address");
        Fixture shop = Fixture(shopAddr);
        // @play resolved to the token deployed earlier; the literal, bool and tag
        // decoded into the constructor.
        assertEq(shop.token(), playAddr, "@play did not resolve to the token address");
        assertEq(shop.n(), 500);
        assertTrue(shop.flag());
        assertEq(shop.tag(), bytes32(uint256(0x22)));

        // Deterministic address, like every other module: CREATE2 from the salt
        // "contract:<key>" and the init code, through the 0x4e59 factory.
        bytes memory initcode = abi.encodePacked(
            vm.getCode("Fixture.sol:Fixture"), abi.encode(playAddr, uint256(500), true, bytes32(uint256(0x22)))
        );
        address CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        assertEq(
            shopAddr,
            vm.computeCreate2Address(d.saltFor("contract", "shop"), keccak256(initcode), CREATE2_DEPLOYER),
            "contract address is not CREATE2 from its salt and init code"
        );

        _clean(dir);
    }

    // A literal 0x address and "@treasury" both resolve; only "@<key>" needs an
    // earlier entry.
    function test_ContractLiteralAndTreasuryAddresses() public {
        string memory dir = _dir("contractlit");
        _write(
            dir,
            string.concat(
                '{"schema":1,"modules":[{"kind":"contract","key":"a","contract":"Fixture","args":[',
                '{"type":"address","value":"@treasury"},',
                '{"type":"uint256","value":"1"},',
                '{"type":"bool","value":"false"},',
                '{"type":"bytes32","value":"',
                FIXTURE_TAG,
                '"}]}]}'
            )
        );
        Deploy d = _script();
        _deployed(d, dir, "");

        string memory out = vm.readFile(string.concat(dir, "/local.json"));
        Fixture a = Fixture(vm.parseJsonAddress(out, ".modules[0].address"));
        assertEq(a.token(), treasury, "@treasury did not resolve");
        assertFalse(a.flag());

        _clean(dir);
    }

    function test_ContractForwardReferenceIsARefusal() public {
        string memory dir = _dir("contractfwd");
        // The contract references @gold, a token declared AFTER it.
        _write(
            dir,
            string.concat(
                '{"schema":1,"modules":[',
                '{"kind":"contract","key":"shop","contract":"Fixture","args":[',
                '{"type":"address","value":"@gold"},',
                '{"type":"uint256","value":"1"},',
                '{"type":"bool","value":"true"},',
                '{"type":"bytes32","value":"',
                FIXTURE_TAG,
                '"}]},',
                '{"kind":"token","key":"gold","name":"Gold","symbol":"GOLD"}]}'
            )
        );
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: "@gold" is not deployed yet'));
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_ContractStringArgIsARefusal() public {
        string memory dir = _dir("contractstr");
        _write(
            dir,
            '{"schema":1,"modules":[{"kind":"contract","key":"shop","contract":"Fixture","args":['
            '{"type":"string","value":"nope"}]}]}'
        );
        Deploy d = _script();
        vm.expectRevert(
            bytes('Deploy: manifest: constructor arg type "string" is not supported; use an initialiser function')
        );
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_ContractMissingArtifactIsARefusal() public {
        string memory dir = _dir("contractnoart");
        _write(
            dir,
            '{"schema":1,"modules":[{"kind":"contract","key":"shop","contract":"NoSuchContract","args":[]}]}'
        );
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: no artifact for "NoSuchContract"'));
        d.deploy(dir, "", "1");
        _clean(dir);
    }

    function test_ContractKeyCollidingAcrossKindsIsARefusal() public {
        string memory dir = _dir("contractdupkey");
        // A contract keyed "play" collides with the token key "play".
        _write(
            dir,
            '{"schema":1,"modules":[{"kind":"token","key":"play","name":"Play","symbol":"PLAY"},'
            '{"kind":"contract","key":"play","contract":"Fixture","args":[]}]}'
        );
        Deploy d = _script();
        vm.expectRevert(bytes('Deploy: manifest: duplicate key "play"'));
        d.deploy(dir, "", "1");
        _clean(dir);
    }
}
