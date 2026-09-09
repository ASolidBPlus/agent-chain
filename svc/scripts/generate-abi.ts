// Regenerates src/abi.ts from the compiled Foundry artifacts.
//
// The ABI is COMMITTED rather than read at runtime for two reasons: chain-svc's
// image does not carry the contracts' build output, and `bun test` must run
// without Foundry installed (mesh-agent's CI has no forge). The drift risk that
// creates is covered by the forge CI job re-running this and failing on a diff.
//
//   bun run scripts/generate-abi.ts        # from chain/svc, after `forge build`

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'contracts', 'out');
const TARGET = join(here, '..', 'src', 'abi.ts');

const CONTRACTS = ['VEEBux', 'NameRegistry'] as const;

function abiOf(name: string): unknown[] {
  const path = join(OUT, `${name}.sol`, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`No artifact at ${path}. Run \`forge build\` in chain/contracts first.`);
  }
  const artifact = JSON.parse(raw) as { abi?: unknown[] };
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    throw new Error(`Artifact ${path} has no abi`);
  }
  return artifact.abi;
}

const parts = CONTRACTS.map(
  (name) => `export const ${name}Abi = ${JSON.stringify(abiOf(name), null, 2)} as const;`,
);

writeFileSync(
  TARGET,
  `// GENERATED FILE - do not edit by hand.\n` +
    `// Regenerate with: cd chain/svc && bun run scripts/generate-abi.ts\n` +
    `// Source: chain/contracts/out/<Contract>.sol/<Contract>.json (\`forge build\`).\n` +
    `// The forge CI job regenerates this and fails on a diff, so an ABI change\n` +
    `// that is not reflected here cannot merge.\n\n` +
    parts.join('\n\n') +
    '\n',
  'utf8',
);

console.log(`wrote ${TARGET} (${CONTRACTS.join(', ')})`);
