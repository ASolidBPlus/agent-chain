// The service's error envelope (spec S4). Every failure leaves chain-svc as
// {"error": "<snake_case>", "detail"?: "..."} with the status below, because
// this is the wire contract C5 and org-core are being told to conform to.

/// The complete set of error codes. Adding one is a wire-contract change:
/// callers switch on these strings, so keep them stable and snake_case.
export type ErrorCode =
  | 'invalid_agent_id'
  | 'invalid_name'
  | 'invalid_amount'
  | 'invalid_request'
  | 'unauthorized'
  | 'principal_mismatch'
  | 'not_your_wallet'
  | 'wrong_scope'
  | 'unknown_name'
  /// A bare `to` that is BOTH a registered name and a wallet in the caller's
  /// namespace (§5). 409 rather than 404: both readings exist, so this is a
  /// conflict to resolve, not a miss. Never resolved by guessing - picking
  /// either candidate is the vanity-squat phishing primitive.
  | 'ambiguous_name'
  | 'unknown_intent'
  | 'wallet_frozen'
  | 'over_max_per_tx'
  | 'over_stage_cap'
  | 'intent_unresolved'
  | 'counterparty_denied'
  | 'wallet_not_found'
  | 'chain_error'
  | 'chain_unreachable'
  | 'internal_error';

/// Exported so a RUNTIME check can enumerate the codes: `ErrorCode` is a type
/// and is erased, so nothing downstream could otherwise verify that the code it
/// maps is one this service actually emits.
export const STATUS: Record<ErrorCode, number> = {
  invalid_agent_id: 400,
  invalid_name: 400,
  invalid_amount: 400,
  invalid_request: 400,
  unauthorized: 401,
  // 403, not 401: the caller IS authenticated, it just is not this wallet.
  // Collapsing the two would tell a prober that a token is invalid when the
  // truth is that it belongs to somebody else.
  principal_mismatch: 403,
  not_your_wallet: 403,
  wrong_scope: 403,
  unknown_name: 404,
  ambiguous_name: 409,
  // Deliberately indistinguishable from an intent that belongs to another
  // wallet: see getIntent. A 403 there would confirm the id exists.
  unknown_intent: 404,
  wallet_not_found: 404,
  wallet_frozen: 409,
  // Policy refusals share 409 with `frozen`: the request was well formed and
  // authorised, and the wallet's own policy is what stopped it (spec S5).
  over_max_per_tx: 409,
  over_stage_cap: 409,
  // The intent was reserved and never completed: the first attempt reached the
  // broadcast with an unknown outcome. 409 because retrying UNCHANGED cannot
  // help - it needs reconciliation, not a backoff, so it must not read as 5xx.
  intent_unresolved: 409,
  counterparty_denied: 409,
  chain_error: 502,
  chain_unreachable: 503,
  internal_error: 500,
};

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: string;

  constructor(code: ErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'HttpError';
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }
}

export function errorBody(err: HttpError): { error: ErrorCode; detail?: string } {
  return err.detail ? { error: err.code, detail: err.detail } : { error: err.code };
}

/// Anything that is not an HttpError is a bug in chain-svc, not a caller error.
/// It becomes a 500 with no detail: the message may name a key file path or an
/// RPC URL, and this service holds every wallet key in the game.
export function toHttpError(err: unknown): HttpError {
  return err instanceof HttpError ? err : new HttpError('internal_error');
}
