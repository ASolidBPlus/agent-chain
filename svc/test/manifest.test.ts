// The admin route's port of the manifest grammar, run over the shared case table.
//
// contracts/test/ManifestCases.t.sol runs the SAME rows through Deploy.s.sol. The
// container is the reference: a row's `ok` is what it does, and this asserts the
// port agrees row for row. Refusal wording may differ; the outcome may not.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readManifest, parseManifestText, ManifestError, canon } from '../src/manifest.ts';

interface Row { name: string; manifest: string; ok: boolean; canon?: string }
const rows = JSON.parse(
  readFileSync(new URL('../../deployments/cases/manifest-cases.json', import.meta.url), 'utf8'),
) as Row[];

function outcome(text: string): { ok: boolean; err?: unknown; parsed?: string } {
  try {
    return { ok: true, parsed: canon(readManifest(parseManifestText(text))) };
  } catch (err) {
    return { ok: false, err };
  }
}

describe('the manifest port agrees with the container, row for row', () => {
  // COMPARE TO A VALUE: a table that failed to load would run no rows and pass.
  it('the case table loaded', () => {
    expect(rows.length).toBeGreaterThan(90);
  });

  for (const row of rows) {
    it(`${row.ok ? 'accepts' : 'refuses'}: ${row.name}`, () => {
      const got = outcome(row.manifest);
      expect(got.ok).toBe(row.ok);
      // THE SAME VALUES, not only the same verdict. ManifestCases.t.sol checks
      // the container against this same string; if both pass, the two parse
      // every accepted row identically - and a value read differently would
      // deploy to a different address.
      if (row.ok) expect(got.parsed).toBe(row.canon);
      // A refusal is the manifest's fault, reported as one - never a crash in
      // the parser that happens to land on the same boolean.
      if (!got.ok) expect(got.err).toBeInstanceOf(ManifestError);
    });
  }
});

describe('numbers keep their exact value', () => {
  // THE SILENT WRONG VALUE this port exists to avoid. JSON.parse rounds past
  // 2^53, and 123456789012345678 would have become ...680 - accepted by both
  // paths, and minted wrong on this one.
  it('an 18-digit numeric initialSupply is read exactly', () => {
    const doc = parseManifestText(
      '{"schema":1,"modules":[{"kind":"token","key":"play","name":"P","symbol":"P","initialSupply":123456789012345678}]}',
    );
    expect(readManifest(doc).modules[0].initialSupply).toBe(123456789012345678n);
  });
});
