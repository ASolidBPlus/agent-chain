// Input validation. Everything that can reach a filesystem path or the chain
// goes through here first (spec S4, "path safety and case").

import { formatUnits, parseUnits } from 'viem';
import { HttpError } from './errors.ts';

const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 48;

/// A canonical id is `<org label>:<local id>`, exactly one colon, LOWERCASE.
/// Lowercase is enforced here and nowhere else: the mesh's POST /agents checks
/// only "no colon" (mesh-planner, 19:33 UTC), so this is a real guard rather
/// than a second copy of a fabric check. Never normalise - an uppercase id is
/// rejected, because silently lowercasing it would key money under an id its
/// caller did not ask for.
const CANONICAL_ID = /^[a-z0-9._@-]{1,48}:[a-z0-9._@-]{1,48}$/;

/// A vanity alias uses the full on-chain charset MINUS the colon, because the
/// colon is what namespaces canonical ids and an alias must never impersonate
/// one. Case is preserved: `aIpha.vee` and `alpha.vee` are different names and
/// that difference is a game mechanic (spec S3.2).
const ALIAS = /^[a-zA-Z0-9._@-]+$/;

function assertLength(value: string, code: 'invalid_agent_id' | 'invalid_name'): void {
  // The registry caps names at 48 on-chain. Without this bound a 60-character
  // id passes the shape check here and reverts NameTooLong on-chain - a 400
  // arriving at the caller as a 502.
  if (value.length < MIN_NAME_LENGTH || value.length > MAX_NAME_LENGTH) {
    throw new HttpError(code, `must be ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} characters, got ${value.length}`);
  }
}

export function assertCanonicalAgentId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError('invalid_agent_id', 'agentId is required and must be a string');
  }
  assertLength(value, 'invalid_agent_id');
  if (!CANONICAL_ID.test(value)) {
    throw new HttpError(
      'invalid_agent_id',
      'must be <org label>:<local id> - lowercase, exactly one colon, [a-z0-9._@-]',
    );
  }
  return value;
}

export function assertAlias(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError('invalid_name', 'alias is required and must be a string');
  }
  assertLength(value, 'invalid_name');
  if (!ALIAS.test(value)) {
    throw new HttpError('invalid_name', 'alias must be [a-zA-Z0-9._@-] with no colon');
  }
  return value;
}

/// A name in a lookup position: either a canonical id or a vanity alias. Used
/// by /resolve, /balance, /history and the `to` of a transfer - so a BARE local
/// id (no colon) lands here and is refused by the alias rules only if it also
/// fails the charset. A bare local id IS a syntactically valid alias, which is
/// why "unknown" is decided by the registry lookup, not by this function.
export function assertLookupName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError('invalid_name', 'name is required and must be a string');
  }
  assertLength(value, 'invalid_name');
  const colons = value.split(':').length - 1;
  if (colons > 1) {
    // `orch:pod1:alice` is a relay display artefact, never an identity.
    throw new HttpError('invalid_name', 'a name has at most one colon; a two-colon origin is a display artefact');
  }
  if (colons === 1) return assertCanonicalAgentId(value);
  if (!ALIAS.test(value)) {
    throw new HttpError('invalid_name', 'name must be [a-zA-Z0-9._@-]');
  }
  return value;
}

/// Amounts arrive as a JSON number or a decimal string and leave as decimal
/// strings in whole VEE (spec S4). Never as JSON numbers: 18 decimals do not
/// survive an IEEE double, and this is the money.
export function parseVee(value: unknown, field = 'vee'): bigint {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HttpError('invalid_amount', `${field} must be finite`);
    text = String(value);
    // A number large or small enough to render in exponent form cannot be fed
    // to parseUnits, and silently rounding the game's money is not an option.
    if (text.includes('e') || text.includes('E')) {
      throw new HttpError('invalid_amount', `${field} is out of range for a JSON number; send it as a decimal string`);
    }
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new HttpError('invalid_amount', `${field} must be a number or a decimal string`);
  }

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new HttpError('invalid_amount', `${field} must be a non-negative decimal amount in whole VEE`);
  }
  const fraction = text.split('.')[1] ?? '';
  if (fraction.length > 18) {
    throw new HttpError('invalid_amount', `${field} has more than 18 decimal places`);
  }

  try {
    return parseUnits(text, 18);
  } catch {
    throw new HttpError('invalid_amount', `${field} could not be parsed as an amount`);
  }
}

export function formatVee(wei: bigint): string {
  return formatUnits(wei, 18);
}

/// Key and policy files are named by the URL-encoded id, so the colon never
/// reaches a path and a traversal attempt cannot escape the directory. The
/// canonical-id check above already refuses `/` and `.` runs, but this is the
/// last line before a filesystem call and it does not assume that.
export function keyFileName(agentId: string): string {
  const encoded = encodeURIComponent(agentId);
  if (encoded.includes('/') || encoded.includes('\\') || encoded.includes('..')) {
    throw new HttpError('invalid_agent_id', 'agentId is not safe as a file name');
  }
  return `${encoded}.json`;
}
