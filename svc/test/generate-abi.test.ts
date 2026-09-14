// §1.2. WHICH CONTRACTS THE GENERATED ABI FILE COVERS.
//
// Increment 2 derived the list from `MODULES`, and the script's own comment
// says why: `forge build` does not delete the artefact of a contract that no
// longer exists, so a glob over `out/` reads files nobody can compile, and the
// drift gate passes against them. Deriving from MODULES made a deleted module
// drop out of the list too.
//
// Increment 3 needs the glob - custom contracts are not in MODULES and that is
// the entire point of the manifest kind - so the protection MODULES was giving
// has to be rebuilt explicitly. That is what `contractsFromArtifacts` is: the
// glob, plus the two filters that make it safe, and this file is the test for
// the filters rather than for the globbing.
//
// A fixture tree rather than the real `out/`: the real one is a build product,
// so a test that read it would pass or fail depending on what was compiled
// last, which is the exact failure mode under test.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractsFromArtifacts } from '../scripts/generate-abi.ts';

let root: string;
let out: string;
let src: string;

/// Writes the artefact Foundry would write for `<sourcePath>: <name>`.
///
/// `metadata.settings.compilationTarget` is the field that says where a
/// contract CAME FROM, and it is the only one that does: the artefact's path
/// (`out/<File>.sol/<Name>.json`) is named for the file, not for the directory,
/// so `out/Deploy.s.sol/Deploy.json` and `out/Token.sol/Token.json` are
/// indistinguishable by path alone. Measured on the real build output.
function artifact(sourcePath: string, name: string, abi: unknown[] = [{ type: 'fallback' }]): void {
  const dir = join(out, sourcePath.split('/').pop()!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({ abi, metadata: { settings: { compilationTarget: { [sourcePath]: name } } } }),
  );
}

/// Writes the source file the artefact claims to have come from.
function source(sourcePath: string): void {
  const full = join(root, sourcePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '// contract source');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abi-gen-'));
  out = join(root, 'out');
  src = join(root, 'src');
  mkdirSync(out, { recursive: true });
  mkdirSync(src, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('contractsFromArtifacts', () => {
  it('returns every contract compiled from src/', () => {
    artifact('src/Token.sol', 'Token');
    source('src/Token.sol');
    artifact('src/Converter.sol', 'Converter');
    source('src/Converter.sol');
    artifact('src/Shop.sol', 'Shop');
    source('src/Shop.sol');

    expect(contractsFromArtifacts(out, root).map((c) => c.name)).toEqual([
      'Converter',
      'Shop',
      'Token',
    ]);
  });

  it('sorts by name, so the generated file does not churn on build order', () => {
    // The drift gate diffs the committed file against a regeneration. Directory
    // order is a filesystem detail, and a generator that inherited it would
    // produce a file that differs between two builds of identical sources -
    // which reads as drift and is not.
    for (const name of ['Zebra', 'Apple', 'Mango']) {
      artifact(`src/${name}.sol`, name);
      source(`src/${name}.sol`);
    }
    expect(contractsFromArtifacts(out, root).map((c) => c.name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('excludes lib/, script/ and test/ compilation targets', () => {
    artifact('src/Token.sol', 'Token');
    source('src/Token.sol');
    artifact('lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol', 'ERC20');
    source('lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol');
    artifact('script/Deploy.s.sol', 'Deploy');
    source('script/Deploy.s.sol');
    artifact('test/Converter.t.sol', 'ConverterTest');
    source('test/Converter.t.sol');

    expect(contractsFromArtifacts(out, root).map((c) => c.name)).toEqual(['Token']);
  });

  it('excludes a src/ contract whose source no longer exists', () => {
    // THE WHOLE REASON THIS FUNCTION EXISTS RATHER THAN AN INLINE GLOB.
    // `forge build` adds to out/ and never removes from it, so deleting
    // src/Gone.sol leaves out/Gone.sol/Gone.json in place, with a src/
    // compilation target, indefinitely. Three separate instruments were fooled
    // by that in one day: this generator, the mutation gate's restored check,
    // and a compose image built from a stale layer.
    artifact('src/Token.sol', 'Token');
    source('src/Token.sol');
    artifact('src/Gone.sol', 'Gone'); // artefact written, source deleted

    expect(contractsFromArtifacts(out, root).map((c) => c.name)).toEqual(['Token']);
  });

  it('refuses two src/ contracts with the same name', () => {
    // `ABIS` is keyed by contract name and `<Name>Abi` is a single exported
    // binding, so two same-named contracts in src/ cannot both be represented.
    // Silently keeping one would key the registry to whichever the filesystem
    // happened to yield first.
    // TWO FILES, one contract name - which is what forge produces and what a
    // name-keyed registry cannot hold. Two files of the SAME name would collide
    // in out/ before they ever reached here, so they are not the case to test.
    artifact('src/Shop.sol', 'Shop');
    source('src/Shop.sol');
    artifact('src/OldShop.sol', 'Shop');
    source('src/OldShop.sol');

    expect(() => contractsFromArtifacts(out, root)).toThrow(/two contracts named "Shop"/);
  });

  it('refuses an artefact with an empty abi', () => {
    artifact('src/Empty.sol', 'Empty', []);
    source('src/Empty.sol');

    expect(() => contractsFromArtifacts(out, root)).toThrow(/has no abi/);
  });

  it('ignores files in out/ that are not contract artefacts', () => {
    // `out/build-info/*.json` is real and is not an artefact: it has no
    // compilationTarget. A generator that assumed every json under out/ was a
    // contract would throw on a normal build tree.
    mkdirSync(join(out, 'build-info'), { recursive: true });
    writeFileSync(join(out, 'build-info', 'abc123.json'), JSON.stringify({ solcVersion: '0.8.28' }));
    artifact('src/Token.sol', 'Token');
    source('src/Token.sol');

    expect(contractsFromArtifacts(out, root).map((c) => c.name)).toEqual(['Token']);
  });

  it('carries each contract abi through, so the generated file is the artefact', () => {
    const abi = [{ type: 'function', name: 'quote', inputs: [], outputs: [], stateMutability: 'view' }];
    artifact('src/Converter.sol', 'Converter', abi);
    source('src/Converter.sol');

    expect(contractsFromArtifacts(out, root)[0]!.abi).toEqual(abi);
  });
});
