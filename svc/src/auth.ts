// Who is calling, and what that entitles them to (spec S4, ruled).
//
// The model this replaces had ONE token shared by hub-core, the facilitator
// API, the setup script and wallet-mcp - and S6 put that token inside the
// persona's own container. A secret handed to the actor you are defending
// against is not an authorization boundary: with it, any persona could sign
// from any wallet and mint itself an org-class wallet from the treasury. Both
// were demonstrated against a live stack before this file existed.
//
// So there are two scopes, and the source of a transfer is DERIVED from the
// credential rather than read from the request body.

import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.ts';
import type { Store } from './store.ts';

export type Principal =
  /// hub-core, the facilitator API, the setup script. May mint, fund, alias,
  /// delete, rotate and read any wallet. Never used by an agent.
  | { scope: 'platform' }
  /// One agent's own credential. May spend from ITSELF and read ITSELF, and
  /// can do nothing else - it cannot mint, fund, alias, delete or rotate.
  | { scope: 'wallet'; agentId: string };

/// Length-safe and short-circuit-free. timingSafeEqual throws on a length
/// mismatch, which is itself a length oracle, so the difference is folded into
/// the result instead.
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/// Wallet tokens are stored only as a hash: a leaked keystore volume or a
/// database dump must not hand someone every agent's spending credential.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function authenticate(header: string | undefined, platformToken: string, store: Store): Principal {
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) throw new HttpError('unauthorized');
  const presented = header.slice(prefix.length);
  if (presented === '') throw new HttpError('unauthorized');

  if (constantTimeEquals(presented, platformToken)) return { scope: 'platform' };

  // A 256-bit random token looked up by exact hash: there is no useful timing
  // oracle in a hash-table hit, and no prefix to walk.
  const agentId = store.agentForTokenHash(hashToken(presented));
  if (agentId) return { scope: 'wallet', agentId };

  throw new HttpError('unauthorized');
}

export function requirePlatform(principal: Principal, what: string): void {
  if (principal.scope !== 'platform') {
    throw new HttpError('wrong_scope', `${what} requires the platform credential`);
  }
}

/// The rule that makes the drain impossible: the source of a transfer is the
/// AUTHENTICATED principal. A body `fromAgentId` is tolerated only when it
/// agrees, so an existing caller that sends it keeps working and a caller that
/// lies is refused rather than quietly overridden.
export function walletPrincipal(principal: Principal, claimed: unknown): string {
  if (principal.scope !== 'wallet') {
    throw new HttpError('wrong_scope', 'signing requires a wallet credential, not the platform one');
  }
  if (claimed !== undefined && claimed !== null && claimed !== principal.agentId) {
    throw new HttpError('principal_mismatch', 'fromAgentId does not match the wallet this credential belongs to');
  }
  return principal.agentId;
}

/// Reads are self-only under a wallet credential, unrestricted under the
/// platform one.
export function assertMayRead(principal: Principal, canonical: string | null): void {
  if (principal.scope === 'platform') return;
  if (canonical !== principal.agentId) {
    throw new HttpError('not_your_wallet', 'a wallet credential can only read its own wallet');
  }
}
