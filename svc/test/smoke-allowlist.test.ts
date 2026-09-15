// Security review finding 3: the compose smoke's example `calls.json` lives in
// a heredoc inside `verify-calls.sh`, and that script needs Anvil and a running
// chain-svc, so CI never runs it. The example was therefore the one allowlist in
// the repository that nothing parsed - and it is the one an operator copies.
//
// THE PICK, stated in the PR body: EXTRACT the heredoc rather than move it to a
// shared fixture file. The example stays inline where a reader of the smoke sees
// it beside the calls it enables, and the script keeps needing nothing but
// itself at runtime. The cost of that pick is that the extraction can go quiet -
// find nothing and pass - so the extractor THROWS on a missing delimiter and a
// row below proves it does.
//
// Loaded through `CallPolicy`, which is the path the service takes: read the
// file, parse it, and on failure CLOSE the op and log rather than throw. So a
// broken example would show up here as ZERO entries, not as an exception - the
// assertions are on the entries and on the log, never on a throw.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi } from 'viem';
import { CallPolicy } from '../src/calls.ts';
import { buildModules, type Modules } from '../src/modules.ts';
import { ABIS } from '../src/abi.ts';
import type { Deployment } from '../src/chain.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = join(PKG, 'scripts', 'verify-calls.sh');

/// The bytes between `<<'CALLS_JSON'` and the closing delimiter.
///
/// THROWS RATHER THAN RETURNING '' when it finds nothing. An extractor that
/// answers empty on a renamed delimiter hands every assertion below a document
/// with no entries in it, and "no entries" is also what a BROKEN example looks
/// like - so the test would go green for the one reason it exists to catch.
export function extractHeredoc(script: string, delimiter: string): string {
  const open = `<<'${delimiter}'\n`;
  const start = script.indexOf(open);
  if (start === -1) {
    throw new Error(`no heredoc opening for ${delimiter}: the smoke moved or renamed it`);
  }
  const from = start + open.length;
  const end = script.indexOf(`\n${delimiter}\n`, from);
  if (end === -1) {
    throw new Error(`heredoc ${delimiter} is never closed`);
  }
  return script.slice(from, end);
}

/// The smoke's deployment: two tokens, the registry and the converter, against
/// the REAL generated ABI table. Not a hand-written ABI - the defect class here
/// is an example naming a function the contract does not have, and an ABI
/// written beside the test would have whatever the test author believed.
async function smokeModules(): Promise<Modules> {
  const deployment = {
    schema: 1,
    chainId: 31337,
    treasury: '0x0000000000000000000000000000000000000001',
    modules: [
      { kind: 'token', key: 'play', contract: 'Token', address: '0x00000000000000000000000000000000000000aa' },
      { kind: 'token', key: 'gold', contract: 'Token', address: '0x00000000000000000000000000000000000000bb' },
      { kind: 'names', contract: 'NameRegistry', address: '0x00000000000000000000000000000000000000cc' },
      { kind: 'converter', contract: 'Converter', address: '0x00000000000000000000000000000000000000dd' },
    ],
  } as unknown as Deployment;
  const meta: Record<string, { symbol: string; decimals: number }> = {
    '0x00000000000000000000000000000000000000aa': { symbol: 'PLAY', decimals: 18 },
    '0x00000000000000000000000000000000000000bb': { symbol: 'GOLD', decimals: 18 },
  };
  return buildModules(deployment, async (a) => meta[a]!, ABIS as Record<string, Abi>);
}

let dir: string;
let logged: string[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'smokecalls-')); logged = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function load(text: string) {
  writeFileSync(join(dir, 'calls.json'), text);
  return new CallPolicy(dir, await smokeModules(), (line) => logged.push(line));
}

describe("the compose smoke's example allowlist", () => {
  const text = extractHeredoc(readFileSync(SMOKE, 'utf8'), 'CALLS_JSON');

  it('loads, with every entry the file declares', async () => {
    const { entries } = (await load(text)).snapshot();
    // TWO INDEPENDENT DERIVATIONS COMPARED, not a count compared to zero. A
    // loader that dropped four of five entries and kept one would satisfy
    // "more than none"; it cannot satisfy "as many as the file declares".
    const declared = text.match(/"contract"\s*:/g)?.length ?? 0;
    expect(declared).toBeGreaterThan(0);
    expect(entries.length).toBe(declared);
    // THE LOADER'S OWN COUNT IS THE THIRD DERIVATION, and it is the one an
    // operator reads at boot. `logged` is not empty on success - it carries the
    // success line - so the absence of a complaint is asserted by naming the
    // complaint, not by asserting nothing was said.
    expect(logged.join('\n')).toContain(`${declared} entries from `);
    expect(logged.join('\n')).not.toContain('is not usable');
  });

  it('every entry names a function the real ABI has', async () => {
    const { entries, find } = (await load(text)).snapshot();
    for (const e of entries) {
      expect(find(e.contract, e.function)).toBeDefined();
    }
  });

  // THE CONTROL. Every assertion above passes trivially against a file that
  // parses; this proves they can fail - the loader fails CLOSED and says so,
  // which is the shape a real breakage in the smoke would take.
  it('control: a broken example is zero entries and a log line, not a throw', async () => {
    const broken = text.replace('"function": "quote"', '"function": "noSuchFunction"');
    expect(broken).not.toBe(text);
    const { entries } = (await load(broken)).snapshot();
    expect(entries).toEqual([]);
    expect(logged.join('\n')).toContain('noSuchFunction');
  });

  // THE GUARD ON THE GUARD. If the smoke renames or removes the heredoc, this
  // file must go red rather than quietly measuring an empty string. The
  // extraction runs at describe time, so that failure takes the whole FILE
  // down rather than one row - the loudest signal available, and safe here
  // because this file holds nothing else. Measured: renaming the delimiter
  // exits 1 with `no heredoc opening`.
  it('the extractor refuses a script with no such heredoc, rather than answering empty', () => {
    expect(() => extractHeredoc('echo hello\n', 'CALLS_JSON')).toThrow(/no heredoc opening/);
    expect(() => extractHeredoc("cat > f <<'CALLS_JSON'\nunterminated\n", 'CALLS_JSON')).toThrow(/never closed/);
  });
});
