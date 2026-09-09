// Source-reading helpers shared by the structural guards.
//
// EXTRACTED BECAUSE THE SAME DEFECT APPEARED IN TWO FILES: both `fees.test.ts`
// and `spawn.test.ts` scan braces over RAW SOURCE, and a brace or a call name
// inside a COMMENT breaks each of them. A second copy of the fix would have
// been a second authority for one rule - the thing these guards keep catching
// in the code they check.

/// Blanks comment BODIES, preserving newlines and length, so a scan over the
/// result has the same offsets as the original.
///
/// `callBlocks` scanned RAW SOURCE, so a comment naming `.writeContract(`
/// produced a PHANTOM BLOCK - and because the scan then advanced past that
/// phantom's braces, THE REAL SITES AFTER IT WERE NEVER LOOKED AT. It failed
/// loudly rather than silently, so the direction was safe; but this file's own
/// header is forty lines naming exactly those strings, so the check reddened on
/// its own explanation.
///
/// `topLevelLines` already knew how to skip comments. The same file contained
/// the capability and the omission.
export function blankComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += ' '.repeat(end - i);
      i = end - 1;
      continue;
    }
    if (two === '/*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      // Newlines kept so line numbers and line-keyed logic survive.
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}

/// Brace-balanced from the call's opening `{`, NOT up to the first `})` - the
/// argument objects contain nested literals, and a naive slice cuts the block
/// in half and silently checks less than it claims.
export function callBlocks(src: string, needle: string): string[] {
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
