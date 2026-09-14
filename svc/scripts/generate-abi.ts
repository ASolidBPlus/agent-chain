// Regenerates src/abi.ts from the compiled Foundry artifacts.
//
// The ABI is COMMITTED rather than read at runtime for two reasons: chain-svc's
// image does not carry the contracts' build output, and `bun test` must run
// without Foundry installed (the harness's CI has no forge). The drift risk that
// creates is covered by the forge CI job re-running this and failing on a diff.
//
//   bun run scripts/generate-abi.ts        # from svc, after `forge build`

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = join(here, '..', '..', 'contracts');
const OUT = join(CONTRACTS_ROOT, 'out');
const TARGET = join(here, '..', 'src', 'abi.ts');

export interface ArtifactContract {
  name: string;
  /// As Foundry recorded it, relative to contracts/: `src/Converter.sol`.
  sourcePath: string;
  abi: unknown[];
}

/// Every contract compiled from `contracts/src`, with its ABI.
///
/// UNTIL INCREMENT 3 THIS LIST WAS `Object.values(MODULES)`, and that was not an
/// arbitrary choice - it was load-bearing. `forge build` ADDS to `out/` and
/// never removes from it, so the artefact of a deleted contract survives
/// indefinitely, and a generator that globbed `out/` would emit an ABI for a
/// contract nobody can compile while the drift gate passed against it. Deriving
/// the list from MODULES made a deleted module drop out of the list too.
///
/// A custom contract is not in MODULES - that is the entire point of the
/// `contract` manifest kind - so the glob is now unavoidable and the protection
/// MODULES was giving has to be rebuilt explicitly. It is the two filters below,
/// and they are the reason this is a tested function rather than four lines
/// inline:
///
///   1. COMPILED FROM `src/`, read from `metadata.settings.compilationTarget`
///      rather than inferred from the artefact's path. The path is named for the
///      file, so `out/Deploy.s.sol/Deploy.json` and `out/Token.sol/Token.json`
///      look alike; the compilation target is where a contract came FROM, and
///      it is the only field that says so.
///   2. THE SOURCE STILL EXISTS. Filter 1 alone does not survive a deletion:
///      `src/Gone.sol`'s artefact keeps a `src/` target forever. Three separate
///      instruments were fooled by a build directory outliving its source in one
///      day - this generator, the mutation gate's restored check, and a compose
///      image built from a stale layer - so this one says out loud that an
///      artefact is EVIDENCE OF A PAST BUILD, not evidence of a contract.
///
/// Sorted by name: directory order is a filesystem detail, and a generated file
/// that inherited it would differ between two builds of identical sources, which
/// reads as drift and is not.
export function contractsFromArtifacts(outDir: string, contractsRoot: string): ArtifactContract[] {
  const found: ArtifactContract[] = [];
  const seen = new Map<string, string>();

  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(outDir, entry.name))) {
      if (!file.endsWith('.json')) continue;
      const path = join(outDir, entry.name, file);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        abi?: unknown[];
        metadata?: { settings?: { compilationTarget?: Record<string, string> } };
      };

      // `out/build-info/*.json` is a real file with no compilation target, and
      // so is anything else a future forge version drops in here. Not an error:
      // this loop's job is to FIND contracts, not to assert that every file
      // under out/ is one.
      const target = parsed.metadata?.settings?.compilationTarget;
      if (!target) continue;
      const [sourcePath, name] = Object.entries(target)[0] ?? [];
      if (!sourcePath || !name) continue;

      if (!sourcePath.startsWith('src/')) continue;
      if (!existsSync(join(contractsRoot, sourcePath))) continue;

      const clash = seen.get(name);
      if (clash) {
        // `ABIS` is keyed by contract name and `<Name>Abi` is one exported
        // binding, so two same-named contracts cannot both be represented.
        // Keeping either would key the registry on directory order.
        throw new Error(
          `contracts/src has two contracts named "${name}" (${clash} and ${sourcePath}); ` +
            `the ABI registry is keyed by name, so one must be renamed`,
        );
      }
      if (!Array.isArray(parsed.abi) || parsed.abi.length === 0) {
        throw new Error(`Artifact ${path} has no abi`);
      }
      seen.set(name, sourcePath);
      found.push({ name, sourcePath, abi: parsed.abi });
    }
  }

  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function render(contracts: ArtifactContract[]): string {
  const parts = contracts.map(
    (c) => `export const ${c.name}Abi = ${JSON.stringify(c.abi, null, 2)} as const;`,
  );
  // ABIS is what makes a custom contract callable with no chain-svc code: the
  // registry looks a manifest entry's `contract` name up here (modules.ts §1.3)
  // rather than switching on a kind, so adding a contract to src/ and to the
  // manifest is the whole of adding a callable contract.
  const registry =
    `export const ABIS: Record<string, Abi> = {\n` +
    contracts.map((c) => `  ${c.name}: ${c.name}Abi as unknown as Abi,`).join('\n') +
    `\n};\n`;

  return (
    `// GENERATED FILE - do not edit by hand.\n` +
    `// Regenerate with: cd svc && bun run scripts/generate-abi.ts\n` +
    `// Source: contracts/out/<Contract>.sol/<Contract>.json (\`forge build\`).\n` +
    `// The forge CI job regenerates this and fails on a diff, so an ABI change\n` +
    `// that is not reflected here cannot merge.\n` +
    `//\n` +
    `// Every contract compiled from contracts/src is here, not only the typed\n` +
    `// modules: a custom contract deployed by the manifest is callable through\n` +
    `// the generic call op, and its ABI is how chain-svc encodes that call.\n\n` +
    `import type { Abi } from 'viem';\n\n` +
    parts.join('\n\n') +
    '\n\n' +
    registry
  );
}

if (import.meta.main) {
  const contracts = contractsFromArtifacts(OUT, CONTRACTS_ROOT);
  if (contracts.length === 0) {
    throw new Error(`No contract artifacts under ${OUT}. Run \`forge build\` in contracts first.`);
  }
  writeFileSync(TARGET, render(contracts), 'utf8');
  console.log(`wrote ${TARGET} (${contracts.map((c) => c.name).join(', ')})`);
}
