// §1b. THE `"unlimited"` SPELLING, ON BOTH SIDES.
//
// It cannot be shared by import. wallet-mcp's ONLY reference to chain-svc is
// `import type { ErrorCode }`, which is erased - so that package carries ZERO
// RUNTIME DEPENDENCY on chain-svc and runs with it absent. org-core relies on
// that by loading `Wallet` as a library in a process where chain-svc does not
// exist. A value import of the constant would be the first runtime import and
// would end the property.
//
// So it is declared twice and asserted equal HERE, in svc/test, which may
// import both. The arrangement `matchesPattern`, `resolveToken` and
// `capsRefusal` already have, for the same reason and in the only direction
// that preserves it: a test under wallet-mcp importing chain-svc would still be
// a second place the dependency exists, and the next reader takes that as
// permission.
//
// IN ITS OWN FILE rather than beside the other agreement tests, because it is
// the one assertion that cannot compile until BOTH halves of this PR are
// present. In policy.test.ts a missing export is a SyntaxError that fails the
// whole module, hiding forty-six unrelated tests behind an expected red. Here
// it hides one.
//
// A fourth spelling of this string is an uncapped wallet that looks capped.

import { describe, it, expect } from 'bun:test';
import { UNLIMITED as UNLIMITED_SVC } from '../src/policy.ts';
import { UNLIMITED as UNLIMITED_MCP } from '../../wallet-mcp/src/policy.ts';

describe('the "unlimited" constant', () => {
  it('is spelled identically in both packages', () => {
    expect(UNLIMITED_MCP).toBe(UNLIMITED_SVC);
  });

  it('is the exact string the spec names, not merely equal to itself', () => {
    // COMPARE TO A VALUE. Without this row both sides could drift to the same
    // wrong string together and the assertion above would still pass - the
    // agreement would hold and the meaning would be gone.
    expect(UNLIMITED_SVC).toBe('unlimited');
  });
});
