// Every transaction chain-svc sends must be free.
//
// WHY THIS GUARD IS STRUCTURAL. The property is not "this transaction carried
// zero fees" - it is "NO SEND SITE OMITS THEM", a claim about the SET of call
// sites. A behavioural test can only assert the sites it knows about, so it is
// exactly blind to the failure that matters: A SITE ADDED LATER. The defect
// being fixed here was six sites all omitting the fields by default, and the
// fix is worthless if the seventh does the same in a month.
//
// It is also invisible without a guard. Omitting the fee fields does not fail,
// throw, or look wrong in review - the transaction succeeds, it just is not
// free.
//
// THREE WAYS THIS GUARD HAS BEEN WRONG, all found by mutants and all the same
// mistake at a different depth - it kept checking that a STRING WAS PRESENT
// rather than that THE CODE DOES THE THING:
//
//   1. `src.includes('...ZERO_FEES')` - file-scoped, satisfied by the token
//      appearing anywhere, including at another site.
//   2. `block.includes(...)` - site-scoped, but satisfied by the token in a
//      COMMENT inside that very block.
//   3. an own-line spread - satisfied while a LATER KEY OVERRODE IT. A later
//      key wins in an object literal, so `...ZERO_FEES, maxPriorityFeePerGas:
//      1000000000n` sends at exactly the 1 gwei this change exists to remove.
//      That is not an analogue of the original bug; it IS the original bug,
//      passing.
//
// So it now asserts BOTH directions at the site: the spread is present at the
// top level of the request object, AND no explicit fee key is there to beat it.
//
// A FOURTH DEPTH, ON A DIFFERENT AXIS. The three above are all about verifying
// a site ALREADY FOUND. This one is about which sites get LOOKED FOR:
// `SEND_CALLS` spelled two of its three needles with a receiver name
// (`walletClient.writeContract(`), so a send site was invisible if the client
// variable happened to be called anything else - measured, a new file using
// `wc.writeContract(` with no spread left the suite green, and renaming that
// one variable made it red. `expect(total).toBe(6)` cannot see it either: an
// unseen site contributes ZERO blocks, so the total is still 6. REMOVE-safe and
// ADD-blind, which is the exact trade this file's headline warns about.
//
// ⚠ AND THE ENUMERATION HAS NOT LEFT, IT HAS MOVED. `FILES` was a hand-written
// list and became a glob; `SEND_CALLS` is STILL a hand-written list, now of call
// spellings. Nothing here can catch a viem method that puts a transaction on the
// wire and is not in it - a new API in a future viem, say. That residual is real
// and is stated rather than guarded, because a half-guard implying coverage is
// how the three defects above got written. WHEN VIEM IS UPGRADED, SOMEBODY HAS
// TO READ ITS CHANGELOG FOR NEW TRANSACTION METHODS; this file cannot.
//
// The rule underneath: WHEN A FIX REPLACES AN ENUMERATION WITH A DERIVATION,
// CHECK WHETHER THE DERIVATION RESTS ON A SECOND ENUMERATION UNDERNEATH.

import { describe, it, expect } from 'bun:test';
import { readdirSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url);

/// The viem calls that put a transaction on the wire, or build the request that
/// gets signed. `prepareTransactionRequest` is where viem INJECTS its 1 gwei
/// default, so it counts even though it does not broadcast; `sendRawTransaction`
/// does not, because by then the fees are already in the signed bytes.
const SEND_CALLS = [
  '.writeContract(',
  '.sendTransaction(',
  'prepareTransactionRequest(',
];

const FEE_KEY = /^\s*max(?:Priority)?FeePerGas\s*:/;

/// Walks source skipping strings and comments, so "present" means PRESENT AS
/// CODE. A regex over raw text cannot tell `...ZERO_FEES,` from
/// `// ...ZERO_FEES,` or `/* ...ZERO_FEES, */`, and this guard has been fooled
/// by the first of those already.
function topLevelLines(block: string): string[] {
  const lines: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < block.length; i++) {
    const c = block[i]!;
    const two = block.slice(i, i + 2);
    // A trailing `//` comment must END THE LINE, not append a newline to the
    // buffer: appending merged the commented line with the NEXT one, so
    // FEE_KEY's `^` never saw the following line's start and an override one
    // line below a comment went unseen. Ending the line here fixes every
    // consumer keyed on line starts at once; relaxing FEE_KEY to /m would have
    // taught one consumer to tolerate the merge.
    if (two === '//') {
      const nl = block.indexOf('\n', i);
      lines.push(cur);
      cur = '';
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (two === '/*') { const end = block.indexOf('*/', i + 2); i = end === -1 ? block.length : end + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < block.length && block[i] !== quote) i += block[i] === '\\' ? 2 : 1;
      cur += 'STR';
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth++;
    if (c === '}' || c === ')' || c === ']') depth--;
    // Depth 1 is the request object's own keys. A spread nested deeper belongs
    // to some inner object and does not reach the transaction.
    if (c === '\n') { lines.push(cur); cur = ''; continue; }
    if (depth === 1) cur += c;
  }
  lines.push(cur);
  return lines;
}

/// Brace-balanced from the call's opening `{`, NOT up to the first `})` - the
/// argument objects contain nested literals, and a naive slice cuts the block
/// in half and silently checks less than it claims.
function callBlocks(src: string, needle: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return blocks;
    const open = src.indexOf('{', at);
    if (open === -1) return blocks;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    blocks.push(src.slice(open, i + 1));
    from = i + 1;
  }
}

/// GLOBBED, NOT NAMED. This was a hand-written list of two files, with a
/// comment claiming the naming was what stopped a new file slipping past.
/// Measured, naming is PRECISELY what let one through: a new `sweeper.ts` with
/// a `writeContract` and no spread passed the whole suite. The file's own
/// opening paragraph gives "a site added later" as the reason this guard is
/// structural at all, so a list that cannot see a new file delivers something
/// narrower than it claims - and "loudly, in review" is not a check.
function sourceFiles(): string[] {
  return readdirSync(SRC).filter((f) => f.endsWith('.ts')).sort();
}

describe('every send site carries explicit zero fees', () => {
  it('spreads ZERO_FEES at every viem send call in the service', async () => {
    let total = 0;
    for (const file of sourceFiles()) {
      const src = await Bun.file(new URL(file, SRC)).text();
      for (const needle of SEND_CALLS) {
        for (const block of callBlocks(src, needle)) {
          total++;
          const lines = topLevelLines(block);
          const spread = lines.some((l) => /^\s*\.\.\.ZERO_FEES,?\s*$/.test(l));
          // A LATER KEY WINS. The spread being present says nothing if an
          // explicit fee key follows it in the same object.
          const override = lines.some((l) => FEE_KEY.test(l));
          expect(`${file} ${needle} spread=${spread} override=${override}`).toBe(
            `${file} ${needle} spread=true override=false`,
          );
        }
      }
    }
    // COMPARE TO A VALUE. Without this, a refactor renaming the viem calls
    // would find zero blocks, assert nothing, and pass - absence reading as
    // compliance.
    //
    // It is REMOVE-safe and ADD-BLIND, deliberately stated: it catches sites
    // VANISHING, and cannot catch one MORE that the needles do not match, since
    // an unseen site contributes zero blocks and leaves the total unchanged.
    // The needles being unqualified is what covers the add direction.
    expect(total).toBe(6);
  });

  it('ZERO_FEES is actually zero on both fields', async () => {
    const { ZERO_FEES } = await import('../src/chain.ts');
    expect(ZERO_FEES.maxFeePerGas).toBe(0n);
    expect(ZERO_FEES.maxPriorityFeePerGas).toBe(0n);
  });
});
