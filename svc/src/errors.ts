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
  | 'unknown_name'
  | 'wallet_frozen'
  | 'wallet_not_found'
  | 'chain_error'
  | 'chain_unreachable'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  invalid_agent_id: 400,
  invalid_name: 400,
  invalid_amount: 400,
  invalid_request: 400,
  unauthorized: 401,
  unknown_name: 404,
  wallet_not_found: 404,
  wallet_frozen: 409,
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
