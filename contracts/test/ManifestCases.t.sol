// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// Exposes the manifest grammar the container applies, end to end, as one call.
///
/// END TO END, NOT `_readManifest` ALONE. The container reads a contract entry's
/// constructor arguments at deploy time, inside the broadcast, so `_readManifest`
/// accepts a manifest whose arguments are wrong and the deploy fails later. The
/// admin route checks them before it sends anything. Comparing the route against
/// `_readManifest` alone would have the two disagree on every bad-argument row,
/// so this runs everything the container would run on the document: the module
/// grammar, the converter pairs, and every contract entry's arguments.
contract ManifestHarness is Deploy {
    /// Everything the container would run on the document, returning what it
    /// PARSED as one canonical string - see `canon` in the case table.
    function check(string memory json) external view returns (string memory) {
        ModuleSpec[] memory mods = _readManifest(json);
        ConverterPair[] memory pairs = _readConverterPairs(json, mods);
        // Placeholder addresses: argument encoding only needs SOME address for
        // each earlier module and for the treasury, not a deployed one.
        address[] memory addrs = new address[](mods.length);
        for (uint256 i = 0; i < mods.length; i++) addrs[i] = address(uint160(i + 1));
        for (uint256 i = 0; i < mods.length; i++) {
            if (_eq(mods[i].kind, KIND_CONTRACT)) _encodeContractArgs(json, i, mods, addrs, address(0xBEEF));
        }
        return canon(mods, pairs);
    }

    // `kind|key|name|symbol|initialSupply|tld` per module, `;`-separated, then
    // `#`, then each pair as source, `>`, target, an at-sign, and the rate.
    // (Plain comments: NatSpec reads an at-sign followed by a word as a tag.)
    // These are the values that reach the chain - a token's name and symbol
    // are constructor arguments, so they are part of the init code and
    // therefore of the CREATE2 address.
    function canon(ModuleSpec[] memory mods, ConverterPair[] memory pairs) public pure returns (string memory out) {
        for (uint256 i = 0; i < mods.length; i++) {
            if (i > 0) out = string.concat(out, ";");
            out = string.concat(
                out, mods[i].kind, "|", mods[i].key, "|", mods[i].name, "|", mods[i].symbol, "|",
                vm.toString(mods[i].initialSupply), "|", mods[i].tld
            );
        }
        out = string.concat(out, "#");
        for (uint256 i = 0; i < pairs.length; i++) {
            if (i > 0) out = string.concat(out, ";");
            out = string.concat(out, pairs[i].source, ">", pairs[i].target, "@", vm.toString(pairs[i].rate));
        }
    }
}

/// Every row of deployments/cases/manifest-cases.json, through the container's
/// grammar. svc/test/manifest.test.ts runs the same rows through the admin
/// route's port; the two must accept and refuse the same rows. Wording may differ.
contract ManifestCasesTest is Test {
    function test_EveryRowMatchesTheContainerGrammar() public {
        ManifestHarness h = new ManifestHarness();
        string memory table = vm.readFile("../deployments/cases/manifest-cases.json");
        uint256 n = 0;
        while (vm.keyExistsJson(table, string.concat("[", vm.toString(n), "]"))) n++;
        // COMPARE TO A VALUE: a table that failed to read would otherwise run no
        // rows and pass.
        assertGt(n, 90, "the case table did not load");

        uint256 mismatches = 0;
        for (uint256 i = 0; i < n; i++) {
            string memory at = string.concat("[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(table, string.concat(at, ".name"));
            string memory manifest = vm.parseJsonString(table, string.concat(at, ".manifest"));
            bool want = vm.parseJsonBool(table, string.concat(at, ".ok"));
            bool got;
            string memory parsed;
            try h.check(manifest) returns (string memory c) {
                got = true;
                parsed = c;
            } catch {
                got = false;
            }
            if (got != want) {
                mismatches++;
                console.log(got ? "  ACCEPTED, table says refuse:" : "  REFUSED, table says accept:", name);
            } else if (got) {
                // SAME VALUES, not only the same verdict: see ManifestHarness.canon.
                string memory expected = vm.parseJsonString(table, string.concat(at, ".canon"));
                if (keccak256(bytes(parsed)) != keccak256(bytes(expected))) {
                    mismatches++;
                    console.log("  PARSED DIFFERENTLY:", name);
                    console.log("    container:", parsed);
                    console.log("    table:    ", expected);
                }
            }
        }
        assertEq(mismatches, 0, "rows where the container disagrees with the table");
    }
}
