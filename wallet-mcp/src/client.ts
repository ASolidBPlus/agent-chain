// The chain-svc client. The only thing in this package that holds the wallet
// token, and the only place that must never let it escape.

import { CLIENT_MARKER, type WalletConfig } from './config.ts';

export interface ChainSvcError {
  error: string;
  detail?: string;
}

/// What a call to chain-svc did, as DATA. The three cases are not stylistic:
/// they are the only three a retry decision can be built on, and an exception
/// carries none of them.
///
///   response  - chain-svc answered. `status` may still be a refusal; that is
///               an answer, and the model should see it.
///   not_sent  - the request PROVABLY never left this process. Retrying is
///               safe, because nothing happened.
///   unknown   - it left, and no answer came back. This is the case that must
///               not be retried blindly: chain-svc may have moved the money
///               and lost the response, which is exactly what an idempotency
///               key exists for.
///
/// Anything not provably `not_sent` is `unknown`. That is deliberately the
/// pessimistic direction: misreading `unknown` as `not_sent` double-spends,
/// while misreading `not_sent` as `unknown` costs one retry.
export type CallResult =
  | { outcome: 'response'; status: number; body: unknown }
  | { outcome: 'not_sent'; reason: string }
  | { outcome: 'unknown'; reason: string };

/// Failures that can only arise BEFORE any byte reaches the network: the name
/// did not resolve, the connection was refused, or the URL was never valid.
/// Everything else - a reset, a hang-up, a timeout - can happen with a request
/// already in flight, so it is not on this list.
///
/// BOTH vocabularies, because they are different and this ran under the wrong
/// one. Node reports `err.cause.code` as `ECONNREFUSED`; Bun reports
/// `err.code` as `ConnectionRefused`, and this package runs under Bun. Written
/// to Node's convention alone, nothing ever matched and `not_sent` was
/// unreachable - measured, not guessed. That failed SAFE (everything became
/// `unknown`, the pessimistic direction) which is exactly why it would have
/// survived review: the visible behaviour of a dead branch is caution.
const PROVABLY_NOT_SENT = new Set([
  // Node / libuv
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_SOCKET_BAD_PORT',
  // Bun
  'ConnectionRefused',
  'FailedToOpenSocket',
  // Both
  'ERR_INVALID_URL',
]);

export function classify(err: unknown): CallResult {
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  // Bun puts it on the error, Node on the cause. Read both; a numeric code
  // (Bun uses one for TimeoutError) is not a name and must not be matched.
  const own = typeof e?.code === 'string' ? e.code : undefined;
  const nested = typeof e?.cause?.code === 'string' ? e.cause.code : undefined;
  const code = own ?? nested;
  const reason = code ?? (err instanceof Error ? err.name : 'unknown transport failure');

  // A timeout is never `not_sent`, whatever else it carries: the request went
  // out and the answer did not come back. Checked FIRST so no future addition
  // to the set above can accidentally capture it.
  if (err instanceof Error && err.name === 'TimeoutError') return { outcome: 'unknown', reason: 'TimeoutError' };

  return code && PROVABLY_NOT_SENT.has(code)
    ? { outcome: 'not_sent', reason }
    : { outcome: 'unknown', reason };
}

/// Long enough that a slow Anvil mine is not mistaken for a dead service,
/// short enough that a hung chain-svc does not hang the model's tool call.
export const REQUEST_TIMEOUT_MS = 15_000;

export class ChainSvcClient {
  constructor(private readonly config: WalletConfig) {}

  private url(path: string): string {
    return new URL(path, this.config.chainSvcUrl).toString();
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.walletToken}`,
      'content-type': 'application/json',
      // Lets chain-svc stamp `via: "mcp"` on the agent.spend event it emits.
      //
      // A CLAIM, not a boundary: chain-svc enforces the caps and derives the
      // source from the token regardless of this header. Stated the way it has
      // to be read downstream (spec S5): `via` is a BEST-EFFORT DETECTION HINT,
      // NEVER AN AUTHORISATION SIGNAL - a raw caller can forge `via: "mcp"`, so
      // `via: "direct"` means "worth investigating" and `via: "mcp"` never
      // means "cleared". The unspoofable fact is that an agent.spend is
      // emitted at all.
      'x-wallet-client': CLIENT_MARKER,
    };
  }

  /// Never throws - for an HTTP error OR a transport failure. A refusal is
  /// data the model should see, and a transport failure is data the RETRY
  /// decision needs: it used to escape as a raw exception, which meant the one
  /// outcome that must not be blindly retried was the only one delivered in a
  /// form carrying no information about whether it had been sent.
  private async call(path: string, init?: { method?: string; body?: unknown }): Promise<CallResult> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: init?.method ?? 'GET',
        headers: this.headers(),
        // Without this a hung chain-svc hangs the MCP server, and the model
        // waits on a tool call that will never return.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (err) {
      return classify(err);
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { outcome: 'response', status: res.status, body };
  }

  resolve(name: string): Promise<CallResult> {
    return this.call(`/resolve/${encodeURIComponent(name)}`);
  }

  reverse(address: string): Promise<CallResult> {
    return this.call(`/reverse/${encodeURIComponent(address)}`);
  }

  balance(nameOrId: string): Promise<CallResult> {
    return this.call(`/balance/${encodeURIComponent(nameOrId)}`);
  }

  history(nameOrId: string, limit: number): Promise<CallResult> {
    return this.call(`/history/${encodeURIComponent(nameOrId)}?limit=${limit}`);
  }

  intent(intentId: string): Promise<CallResult> {
    return this.call(`/intents/${encodeURIComponent(intentId)}`);
  }

  signTransfer(body: { to: string; vee: string; memo?: string; intentId: string }): Promise<CallResult> {
    return this.call('/sign-transfer', { method: 'POST', body });
  }

  /// §4. The allowlist as THIS wallet may use it - the menu behind the
  /// `contracts` tool.
  ///
  /// NEVER CACHED by its caller, unlike /modules: a deployment's modules cannot
  /// change under a running service, but a scenario may rewrite calls.json
  /// between turns and the menu has to reflect it.
  calls(): Promise<CallResult> {
    return this.call('/calls');
  }

  callContract(body: {
    contract: string;
    function: string;
    args: unknown[];
    intentId: string;
  }): Promise<CallResult> {
    return this.call('/call', { method: 'POST', body });
  }

  readContract(body: { contract: string; function: string; args: unknown[] }): Promise<CallResult> {
    return this.call('/read', { method: 'POST', body });
  }
}
