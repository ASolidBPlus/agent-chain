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
  /// §1b. The wallet's policy sets NO cap for this token, so no amount can be
  /// spent - as distinct from `over_max_per_tx`, where a smaller one could.
  ///
  /// A SPLIT, NOT AN ADDITION. `over_max_per_tx` carried both meanings and
  /// still carries the first; a code is the closed set a model switches on, and
  /// under the old code this one instructed a retry that cannot succeed.
  ///
  /// Persona-facing: a fact about the caller's OWN policy, which it can learn
  /// by trying, so disclosing it discloses nothing.
  | 'no_cap_set'
  | 'over_stage_cap'
  | 'intent_unresolved'
  | 'counterparty_denied'
  /// §1. The TREASURY holds less of this token than the request moves.
  ///
  /// An OPERATOR FACT, withheld from personas: how much the treasury holds is
  /// the game's supply position, and a persona that could read it from a
  /// refusal could probe it by funding. It is a platform-scope endpoint, so
  /// only an operator ever sees this code - but the withholding is declared in
  /// wallet-mcp's REFUSAL_FOR rather than left to that fact, because "no route
  /// reaches it" is a property of today's routes.
  ///
  /// Never topped up implicitly: the operator mints with
  /// `admin-call token.mint(treasury, amount)`. A service that minted to cover
  /// a shortfall would make the supply a function of spending.
  | 'treasury_insufficient'
  | 'wallet_not_found'
  /// The route needs a module this deployment does not have. 404 because the
  /// endpoint genuinely is not there on this deployment - not 501, which would
  /// say the service cannot do it at all, and not 409, which would say the
  /// request conflicts with some state. A deployment's shape is not a state.
  | 'module_not_deployed'
  /// No contract with that key in this deployment's registry. A fact about the
  /// public registry, like `unknown_name`, so a persona sees it: the `contracts`
  /// tool lists exactly what exists, and refusing to say which keys are real
  /// would only make a persona guess.
  | 'unknown_contract'
  /// No token by that key or symbol in this deployment. 404 and persona-facing
  /// for the same reason `unknown_contract` is: which tokens exist is the
  /// public registry, and a persona reads their symbols in every balance and
  /// every history entry.
  ///
  /// DISTINCT FROM `module_not_deployed`, which says this deployment has NO
  /// token module at all. Two different absences: one is a fact about the
  /// registry's contents, the other about the deployment's shape, and only the
  /// first is the caller's business. Collapsing them would have a names-only
  /// deployment tell a persona that its own currency does not exist.
  | 'unknown_token'
  /// The contract exists and this caller may not call this function on it -
  /// either the allowlist has no entry for the pair, or the entry does not
  /// include this wallet's kind. ONE CODE FOR BOTH, deliberately: telling a
  /// persona which of the two it was is telling it what other kinds can do.
  | 'function_not_allowed'
  /// The arguments do not match the function's ABI, or a wallet-scope address
  /// argument was not one of the wire forms its rule allows. Persona-facing
  /// with the index and the expected type, because it is a fact about the
  /// caller's own input, like `invalid_amount`.
  | 'bad_args'
  /// The call was mined and reverted. 409, not 502: the chain is working and
  /// the transaction was accepted - the CONTRACT refused. The persona must know
  /// its call did nothing, so the code is persona-facing; the revert reason is
  /// not, because it is the contract's internal state talking.
  | 'revert'
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
  module_not_deployed: 404,
  unknown_contract: 404,
  unknown_token: 404,
  function_not_allowed: 403,
  bad_args: 400,
  wallet_frozen: 409,
  // Mined and reverted. Shares 409 with the policy refusals for the same
  // reason: the request was well formed and authorised, and something on the
  // far side said no. Retrying it unchanged cannot help.
  revert: 409,
  // Policy refusals share 409 with `frozen`: the request was well formed and
  // authorised, and the wallet's own policy is what stopped it (spec S5).
  over_max_per_tx: 409,
  // 409 with the other policy refusals: well formed, authorised, and the
  // wallet's own policy is what stopped it.
  no_cap_set: 409,
  over_stage_cap: 409,
  // The intent was reserved and never completed: the first attempt reached the
  // broadcast with an unknown outcome. 409 because retrying UNCHANGED cannot
  // help - it needs reconciliation, not a backoff, so it must not read as 5xx.
  intent_unresolved: 409,
  counterparty_denied: 409,
  // 409, with the policy refusals: the request was well formed and authorised,
  // and the state on the far side is what stopped it. Retrying unchanged cannot
  // help - it needs a mint, which is a different request.
  treasury_insufficient: 409,
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
