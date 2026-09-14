// The tools' behaviour, with no MCP in it, so org-core can import this package
// as a library and so the tests exercise the logic rather than a transport.

import { ChainSvcClient, type CallResult } from './client.ts';
import type { WalletConfig } from './config.ts';
import { checkLocally, normaliseVee, readPolicy, type Refusal } from './policy.ts';
import { defaultTokenOf, type ModulesReply } from './modules.ts';
// TYPE-ONLY, and that is load-bearing rather than stylistic: `import type` is
// erased, so wallet-mcp keeps ZERO runtime dependency on chain-svc and still
// runs on node or bun with chain-svc absent (spec S5 - org-core imports this as
// a library). What the import buys is the exhaustiveness: a code added to
// chain-svc without a decision in REFUSAL_FOR fails typecheck here.
import type { ErrorCode } from '../../svc/src/errors.ts';
import { WalletStore } from './store.ts';

/// Where wallet-mcp's facilitator-facing lines go.
///
/// A SINK RATHER THAN A CONSOLE, and required rather than defaulted. The log
/// line below is what makes a generic refusal SAFE rather than merely opaque -
/// the persona is told nothing and someone is told everything - so the channel
/// it is written to is part of the control, not a formatting detail.
///
/// `console.error` was that channel until #99, and it is the wrong one on the
/// path that matters: org-core imports this package AS A LIBRARY (S5), so the
/// global console belongs to org-core and to every package sharing that
/// process. The code is withheld from the persona across the tool boundary and
/// handed back on a channel it may be able to read or replace.
///
/// REQUIRED IS THE WHOLE POINT. A default is a silent borrow: it compiles, it
/// runs, and nobody decides anything. Making it mandatory puts the choice of
/// destination in front of the one caller who knows what the process is -
/// which is why `server.ts` supplies stderr and org-core must supply its own.
export type LogSink = (message: string) => void;

export interface WalletOptions {
  log: LogSink;
  /// The chain-svc /modules reply, fetched by the host and passed in - REQUIRED,
  /// the same way `log` is, so no construction site can forget it and no fetch
  /// happens inside Wallet. The default token's symbol and decimals come from
  /// here; a library host (org-core, once it exists) passes what it fetched.
  modules: ModulesReply;
}

export interface SendResult {
  ok: boolean;
  txHash?: string;
  reason?: Refusal | 'error';
  detail?: string;
}

/// chain-svc's wire codes -> the refusal strings S5 promises the model. An
/// unmapped code becomes a generic error rather than a plausible-looking
/// refusal: telling a persona "counterparty_denied" when the real problem was
/// a 502 would teach it something false about the game.
/// Ten seconds, ruled. Long enough for a receipt on an instant-mining
/// chain, short enough that a tool call still returns.
const RECONCILE_BUDGET_MS = 10_000;

const RECONCILE_INTERVAL_MS = 250;

/// EVERY chain-svc ERROR CODE, DECIDED. Exhaustive over `ErrorCode` by type, so
/// a code added to chain-svc without a decision here FAILS TYPECHECK rather
/// than silently degrading to a generic error nobody notices.
///
/// `null` means GENERIC: the persona sees `reason: "error"` with no detail, and
/// wallet-mcp logs the real code for the facilitator. That logging is what makes
/// generic safe rather than merely opaque - contract drift stays visible to
/// someone, just not to the persona.
///
/// THE MEMBERSHIP TEST, so the next person can apply it rather than copy it: a
/// code is persona-facing when it is a fact about the persona's OWN wallet,
/// policy or input, or about the PUBLIC registry - things it can already learn
/// by `wallet_balance` / `wallet_resolve` or by probing, so telling it changes
/// nothing an attacker could do. The caps are the bound, and knowing the bound
/// is not a bypass. Everything else is generic.
///
/// ⚠ AND A NOTE FOR WHOEVER EXTENDS THIS: an UNKNOWN KEY here means "that is
/// not a chain-svc error code", NEVER "that reason is not persona-facing".
/// `duplicate_intent` is a real `Refusal` that wallet-mcp raises ITSELF - it has
/// no `ErrorCode` preimage because chain-svc answers a duplicate with the
/// ORIGINAL txHash as a success, while this side refuses a repeat under the same
/// id with a DIFFERENT `to` or `vee`. Reading a key rejection as "drop the
/// reason" would delete a refusal the tool description promises.
export const REFUSAL_FOR: Record<ErrorCode, Refusal | null> = {
  // ── Persona-facing: the persona's own wallet, policy or input, or the
  //    public registry. All four policy codes are wallet-mcp's FAST-PATH
  //    COPIES of checks whose authority is chain-svc, so the persona learns
  //    the fast path's answer rather than the boundary's - and it could
  //    provoke exactly that by calling and reading the refusal.
  over_max_per_tx: 'over_max_per_tx',
  over_stage_cap: 'over_stage_cap',
  counterparty_denied: 'counterparty_denied',
  wallet_frozen: 'frozen',
  unknown_name: 'unknown_name',
  ambiguous_name: 'ambiguous_name',
  // The send MAY have happened. The model must be able to tell this apart from
  // every refusal that means nothing moved, or it will retry a live payment.
  intent_unresolved: 'intent_unresolved',
  // Facts about the string the persona just typed.
  invalid_name: 'invalid_name',
  invalid_amount: 'invalid_amount',
  // ── The generic call op (increment 3). Each passes the membership test
  //    above for a different one of its clauses, which is why they are not one
  //    code: the registry is public, the allowlist is this wallet's own policy,
  //    the arguments are this wallet's own input, and a revert is a fact about
  //    what its own call did.
  unknown_contract: 'unknown_contract',
  function_not_allowed: 'function_not_allowed',
  bad_args: 'bad_args',
  // The CODE is persona-facing and the REASON is not. chain-svc decodes the
  // revert reason with the contract's ABI and puts it in its own log sink; what
  // crosses to the persona is "it was mined and nothing changed".
  revert: 'revert',

  // ── Generic: `reason: "error"`, no detail, real code logged for the
  //    facilitator.
  //
  // The auth family can only arise from wallet-mcp misuse or config drift and
  // never from persona input, so a persona learns nothing it can act on and an
  // attacker driving one learns nothing about the money layer.
  unauthorized: null,
  principal_mismatch: null,
  wrong_scope: null,
  not_your_wallet: null,
  // An existence oracle about intents that are not this wallet's.
  unknown_intent: null,
  // The agent id is derived from the credential, never from persona input, so a
  // persona cannot cause this and learns nothing from it.
  invalid_agent_id: null,
  invalid_request: null,
  // Infrastructure: tells a persona only "it did not happen", which the generic
  // reason already says.
  chain_error: null,
  chain_unreachable: null,
  // GENERIC, AND NOT BECAUSE NO ROUTE RAISES IT TODAY. About the persona's OWN
  // wallet it is unreachable for a live persona: a wallet token is minted at
  // spawn beside `markSpawned`, so holding a valid token entails having a
  // spawns row - and if it ever does arise, the store has lost the row, which
  // is a custody fact and facilitator business, the same class as the keystore
  // integrity errors below. About ANY OTHER wallet it is a standing existence
  // oracle. Neither reading is persona-facing, so this does not depend on the
  // current routing and a new wallet-scope path does not reopen it.
  wallet_not_found: null,
  // Keystore integrity: "could not be decrypted", "address does not match its
  // private key". A persona learning any of these learns about the custody of
  // keys it must never learn about, and can act on none of it.
  internal_error: null,
  // The route needs a module this deployment does not have. GENERIC, and it
  // should be unreachable: wallet-mcp reads /modules at startup and never
  // advertises a tool whose module is absent, so a persona cannot call one. If
  // it ever arrives, the tool set and the deployment have diverged - which is a
  // fact about the deployment, not about the persona's request, and it goes to
  // the log sink by name like every other generic mapping.
  module_not_deployed: null,
};
/// The reason a persona sees for a chain-svc error code, or null for generic.
///
/// TAKES A WIRE STRING, NOT AN `ErrorCode`. The map is exhaustive over the codes
/// chain-svc DECLARES; the wire can carry anything - a newer chain-svc, a proxy,
/// a typo. An undeclared code is contract drift, which is FACILITATOR business
/// rather than persona business, so it takes the generic path and is logged by
/// name like every other generic mapping.
///
/// The log line is what makes generic safe rather than merely opaque: the
/// persona is told nothing, and someone is told everything.
export function refusalFor(code: string, warn: LogSink): Refusal | null {
  const known = Object.prototype.hasOwnProperty.call(REFUSAL_FOR, code);
  if (!known) {
    warn(
      `[wallet-mcp] chain-svc returned an error code this build does not know: ${code}. ` +
        `Reported to the model as a generic error. This is contract drift between ` +
        `chain-svc and wallet-mcp, not a persona problem.`,
    );
    return null;
  }
  const mapped = REFUSAL_FOR[code as ErrorCode];
  if (mapped === null) {
    warn(`[wallet-mcp] chain-svc error ${code} reported to the model as a generic error.`);
  }
  return mapped;
}


export class Wallet {
  private readonly client: ChainSvcClient;
  private readonly store: WalletStore;
  private readonly log: LogSink;
  /// The default token's symbol and decimals, from the /modules reply. Only the
  /// money methods use them, and those are only advertised when a default token
  /// exists (server.ts), so the fallbacks below are unreachable in the stdio
  /// path and org-core does not exist yet.
  private readonly symbol: string;
  private readonly decimals: number;

  /// `options` is REQUIRED, and so are `options.log` and `options.modules`.
  /// Every construction site then has to name both, and typecheck is what makes
  /// them - see LogSink above for why a default would have defeated the point.
  constructor(
    private readonly config: WalletConfig,
    options: WalletOptions,
  ) {
    this.client = new ChainSvcClient(config);
    this.store = new WalletStore(config.stateFile);
    this.log = options.log;
    const token = defaultTokenOf(options.modules);
    this.symbol = token?.symbol ?? 'tokens';
    this.decimals = token?.decimals ?? 0;
  }

  /// Strips the wallet token from anything on its way to the model.
  ///
  /// Nothing here should ever contain it - the token only goes into a request
  /// header - so this is the last line, not the first.
  ///
  /// This comment used to say, flatly, that the harness's transcript redactor
  /// does not cover WALLET_TOKEN. True when written (S5 described a hardcoded
  /// list of two) and FALSE since their #18. Keeping the control was right; the
  /// reason had rotted.
  ///
  /// The mechanism, MEASURED rather than reasoned about,
  /// after two wrong accounts of it - one of which was in this comment:
  /// the harness redacts the values of ALLOWLISTED ENV VAR NAMES, whatever route
  /// the credential took to get here. Not the `${VAR}` references (those only
  /// throw on a name that is not allowlisted; they seed nothing), and not the
  /// literal-versus-reference syntax. So `WALLET_TOKEN` is unredacted only if
  /// nobody allowlisted it - which is a fact about a DEPLOYMENT, not a property
  /// of the redactor.
  ///
  /// Worth stating why that matters, because it is not pedantry: A CONTROL KEPT
  /// FOR A REASON THAT ISN'T TRUE IS ONE NOBODY CAN CORRECTLY RETIRE. Whoever
  /// next asks "do we still need this?" would have checked the stale claim,
  /// found it false, and deleted a control that two real cases still need.
  ///
  /// The two that are true (ruled):
  ///
  ///   1. `org-core` imports this package AS A LIBRARY, not over stdio (S5).
  ///      There is no harness in that process at all, so there is no
  ///      transcript redactor to inherit - this is the only redaction there is.
  ///
  ///   2. The allowlist grant is a DEPLOYMENT property this process cannot
  ///      observe, and the measurement above makes it the load-bearing one:
  ///      redaction depends on nothing except whether someone put this name in
  ///      the allowlist. They can narrow or retire it without touching this
  ///      code, and nothing here would know. Defence in depth against a
  ///      neighbouring layer's configuration - the one kind you cannot check.
  ///
  /// Note neither depends on the harness being wrong about anything.
  private redact(text: string): string {
    return text.split(this.config.walletToken).join('[redacted]');
  }

  /// A short token makes redaction WORSE, not weaker: `split` on a two-letter
  /// value rewrites every occurrence of those letters anywhere in a response.
  ///
  /// LENGTH IS A PROXY, NOT THE PROPERTY. The property is "does this value
  /// occur in ordinary text", and a long token can still have it - the harness
  /// measured `password`, eight characters and past their floor, rewriting
  /// both occurrences in "a weak password ... password reuse". So do not read
  /// the threshold below as a safety line: it catches the obvious case, and a
  /// dictionary-word token of any length would still over-match. The real
  /// guarantee is upstream, in chain-svc issuing 32 random bytes.
  /// chain-svc issues 32-byte tokens, so anything short is a misconfiguration
  /// rather than a small secret - and the harness's own transcript redactor
  /// silently declines to redact under 8 characters, so a short token is
  /// unprotected at that layer too. Warned rather than refused: this process
  /// does not get to decide that someone's deployment is invalid, only to say
  /// so. The VALUE is never logged, only its length.
  static warnIfImplausiblyShort(token: string, warn: LogSink): void {
    if (token.length < 16) {
      warn(
        `wallet-mcp: WALLET_TOKEN is ${token.length} characters. chain-svc issues 32-byte tokens, ` +
          `so this is probably a misconfiguration; short values also make redaction over-match and ` +
          `are not redacted at all by the harness's transcript layer below 8.`,
      );
    }
  }

  /// A read path has no use for the not_sent/unknown distinction - nothing was
  /// going to change either way - so both collapse to one unavailable message.
  /// The SEND path must not do this; see `send`.
  private static unreachable(res: CallResult): string | null {
    return res.outcome === 'response' ? null : `chain-svc is unreachable (${res.reason})`;
  }

  private fail(reason: Refusal | 'error', detail?: string): SendResult {
    return { ok: false, reason, ...(detail ? { detail: this.redact(detail) } : {}) };
  }

  async whoami(): Promise<{ agentId: string; address: string | null; aliases: string[] }> {
    const resolved = await this.client.resolve(this.config.agentId);
    const body = resolved.outcome === 'response' ? (resolved.body as { address?: string } | null) : null;
    if (resolved.outcome !== 'response' || resolved.status !== 200 || !body?.address) {
      return { agentId: this.config.agentId, address: null, aliases: [] };
    }
    const reverse = await this.client.reverse(body.address);
    const rev = reverse.outcome === 'response' ? (reverse.body as { aliases?: string[] } | null) : null;
    return { agentId: this.config.agentId, address: body.address, aliases: rev?.aliases ?? [] };
  }

  async balance(): Promise<{ vee: string } | { error: string }> {
    const res = await this.client.balance(this.config.agentId);
    const down = Wallet.unreachable(res);
    if (down || res.outcome !== 'response') return { error: this.redact(down ?? 'balance unavailable') };
    const body = res.body as { vee?: string; error?: string } | null;
    if (res.status !== 200 || !body?.vee) return { error: this.redact(body?.error ?? 'balance unavailable') };
    return { vee: body.vee };
  }

  /// The primary addressing path (spec S5). A persona pays a NAME.
  async resolve(
    name: string,
  ): Promise<
    | { address: string; canonical: string | null; resolvedVia?: string }
    | { error: string; detail?: string }
    | { unreachable: string }
  > {
    const res = await this.client.resolve(name);
    const down = Wallet.unreachable(res);
    // A TRANSPORT FAILURE IS NOT AN ERROR CODE, and it used to arrive in the
    // same `error` field - one field carrying two kinds of thing, so a caller
    // could not tell chain-svc's `not_your_wallet` from wallet-mcp's own
    // "chain-svc is unreachable (ConnectionRefused)". It is now its own shape.
    //
    // The distinction is load-bearing rather than tidy: a chain-svc CODE may be
    // withheld from the persona, while an outage MUST reach it - a persona told
    // a generic "error" during an outage cannot tell "my send was refused" from
    // "the service is down", and a student debugging the game is sent looking
    // for a registration bug that does not exist. That is the flattening the
    // note above forbids; collapsing them into one field made it possible to
    // reintroduce by accident, which is exactly what happened.
    if (down || res.outcome !== 'response') {
      return { unreachable: this.redact(down ?? 'chain-svc did not answer') };
    }
    const body = res.body as {
      address?: string; canonical?: string | null; error?: string; detail?: string; resolvedVia?: string;
    } | null;
    if (res.status !== 200 || !body?.address) {
      // The DETAIL travels with the code. chain-svc names both readings it
      // tried; dropping that here is the flattening this file exists to forbid,
      // one field over.
      return {
        error: this.redact(body?.error ?? 'unknown_name'),
        ...(body?.detail ? { detail: this.redact(body.detail) } : {}),
      };
    }
    // `resolvedVia` says WHICH RULE resolved it - a persona checking who it is
    // about to pay should be able to see that the answer came from its own
    // namespace rather than from an exactly registered name.
    return {
      address: body.address,
      canonical: body.canonical ?? null,
      ...(body.resolvedVia ? { resolvedVia: body.resolvedVia } : {}),
    };
  }

  async history(limit = 20): Promise<Array<Record<string, unknown>> | { error: string }> {
    const res = await this.client.history(this.config.agentId, limit);
    const down = Wallet.unreachable(res);
    if (down || res.outcome !== 'response') return { error: this.redact(down ?? 'history unavailable') };
    if (res.status !== 200 || !Array.isArray(res.body)) {
      const body = res.body as { error?: string } | null;
      return { error: this.redact(body?.error ?? 'history unavailable') };
    }
    return (res.body as Array<Record<string, unknown>>).map((entry) => ({
      // S5 asks for `when`; S4's /history carries a block number and no
      // timestamp, so this is a block height. Flagged for the spec -
      // chain-svc would have to read block timestamps to do better.
      when: entry.blockNumber,
      direction: entry.from === this.config.agentId ? 'out' : 'in',
      counterparty: entry.from === this.config.agentId ? entry.to : entry.from,
      vee: entry.vee,
      ...(entry.memo === undefined ? {} : { memo: entry.memo }),
    }));
  }

  async send(args: { to: unknown; amount: unknown; intent_id: unknown; memo?: unknown }): Promise<SendResult> {
    const to = typeof args.to === 'string' ? args.to.trim() : '';
    const intentId = typeof args.intent_id === 'string' ? args.intent_id.trim() : '';
    // `amount` IS A DECIMAL STRING on every money wire (ruled). A number is
    // tolerated only when it is an INTEGER, which is exactly representable and
    // has nothing to round; a non-integer number is REFUSED rather than
    // rounded, because silent rounding on an amount is the one outcome worth
    // more than the convenience. The tolerance exists because an LLM writes 50
    // as often as it writes "50" - it is not a second supported type.
    const amount = normaliseVee(args.amount);
    const memo = typeof args.memo === 'string' ? args.memo : undefined;

    if (to === '') return this.fail('error', 'to is required and must be a name');
    if (intentId === '') return this.fail('error', 'intent_id is required');
    if (amount === null) {
      return this.fail(
        'error',
        'amount must be a positive decimal string, e.g. "50" or "12.5". A whole number is accepted; ' +
          'a fractional number is not, because it cannot be carried exactly - send it as a string.',
      );
    }

    // Idempotence, and the one refusal only this side can see. A replay of the
    // SAME send returns the original result - the model retried, it did not
    // decide twice. Reusing an intent id for a DIFFERENT send is the mistake
    // `duplicate_intent` exists to name.
    const previous = this.store.recall(intentId);
    if (previous) {
      // The dedupe KEY is the intent id alone (ruled). These are not
      // key components - they are what makes "same id, different send" a
      // REFUSAL rather than a silent replay of the wrong transfer.
      if (previous.to === to && previous.vee === amount) {
        return { ok: true, txHash: previous.txHash };
      }
      return this.fail(
        'duplicate_intent',
        `intent_id ${intentId} was already used to send ${previous.vee} ${this.symbol} to ${previous.to}`,
      );
    }

    // `to` ALWAYS goes through resolve (spec S5): it is a name, never an
    // address and never an id scraped from a message tag. A bare local id is
    // not registered, so it lands here as unknown_name.
    const resolved = await this.resolve(to);
    // AN OUTAGE REACHES THE PERSONA IN FULL, and before any code mapping can
    // reach it. It is a fact about the world rather than about another wallet,
    // and it is the one thing a persona can actually act on - told a bare
    // "error" during an outage, it cannot tell "my send was refused" from "the
    // service is down", which is the flattening this file forbids.
    if ('unreachable' in resolved) return this.fail('error', resolved.unreachable);

    if ('error' in resolved) {
      // DO NOT FLATTEN. This used to map every resolve failure to
      // `unknown_name`, so a chain-svc outage reached the persona as "that name
      // does not exist" - byte-identical to a genuinely unknown name, while the
      // honest "chain-svc is unreachable (...)" was one call away and thrown
      // out at the mapping. That is precisely the failure the note at the top
      // of this file spends twelve lines forbidding, one function earlier on
      // the path that runs first.
      //
      // It matters more here than in the general case: this is a game students
      // DEBUG. An outage dressed as a missing name sends them looking for a
      // registration bug that does not exist.
      // THE DETAIL COMES FROM chain-svc, NOT FROM HERE. Since §5 a bare `to`
      // has TWO readings - the name as typed and the peer in this wallet's own
      // namespace - and the refusal has to name both, or a persona reads "no
      // wallet is registered as toby" while `acme:toby` exists and concludes
      // the registry is broken.
      //
      // Reconstructing that sentence locally would be a second authority for
      // one fact, and the two would drift the first time either side reworded
      // it. chain-svc already says exactly what it tried; this passes it
      // through and adds nothing.
      // ONE DECISION POINT, shared with the send path below. This used to
      // hand-roll its own two-code allowlist and then fall through to
      // `this.fail('error', resolved.error)` - which leaked the real code to
      // the persona exactly as the send path did, and was NOT caught when the
      // map became `Record<ErrorCode, …>`, because this branch never indexed
      // the map. The type change flagged every site that LOOKED UP a code and
      // none that merely PASSED ONE ALONG.
      //
      // Routing both paths through `refusalFor` removes the class rather than
      // the instance: a code's disclosure is decided in one place, and a second
      // site cannot disagree with the first about which codes are safe.
      const mapped = refusalFor(resolved.error, this.log);
      // The detail is chain-svc's own prose - since §5 a bare `to` has TWO
      // readings, and the refusal has to name both or a persona reads "no
      // wallet is registered as toby" while `acme:toby` exists and concludes
      // the registry is broken. Reconstructing that sentence here would be a
      // second authority for one fact. It is passed through, never invented,
      // and NEVER replaced by the code itself.
      return mapped ? this.fail(mapped, resolved.detail) : this.fail('error');
    }

    const local = checkLocally(readPolicy(this.config.policyFile), to, amount, this.decimals);
    if (local) return this.fail(local);

    // THE ONE PLACE THE TWO NAMES MEET. The model fills `amount`; the HTTP
    // body carries `vee`, which is chain-svc's field name until increment 4
    // renames the wire alongside the token argument. Mapped here rather than
    // renamed on both sides, so the tool a persona reads stops naming one
    // deployment's currency without a breaking change to the service contract.
    const res = await this.client.signTransfer({ to, vee: amount, intentId, ...(memo ? { memo } : {}) });

    // THE DISTINCTION THIS WHOLE TYPE EXISTS FOR. A transport failure used to
    // arrive as a raw exception, which carries no answer to the only question
    // that matters here: did the request leave?
    if (res.outcome === 'not_sent') {
      // Provably nothing happened. Saying so is safe, and the model may retry.
      return this.fail('error', `chain-svc could not be reached (${res.reason}); the send did not happen`);
    }
    if (res.outcome === 'unknown') {
      // It left and no answer came back. chain-svc may have moved the money.
      // Deliberately NOT recorded as either a success or a failure: recording
      // success invents a txHash, and recording nothing at all is correct
      // because chain-svc reserved the intent BEFORE broadcasting, so retrying
      // with the SAME intent_id is now safe - it answers with the original
      // transaction rather than sending again. Telling the model to retry with
      // a NEW id would be the double-charge.
      return this.fail(
        'error',
        `the send to ${to} was submitted but chain-svc did not answer (${res.reason}); ` +
          `its outcome is unknown. Retry with the SAME intent_id ${intentId} - that is safe and ` +
          `returns the original result. Do NOT re-send with a new intent_id.`,
      );
    }

    const body = res.body as { txHash?: string; error?: string; detail?: string } | null;

    if (res.status === 200 && body?.txHash) {
      this.store.remember(intentId, { txHash: body.txHash, vee: amount, to, at: Date.now() });
      return { ok: true, txHash: body.txHash };
    }

    // The broadcast-to-record window is chain-svc's problem, not the model's
    // (spec S5). Reconcile here rather than handing a persona a state it has no
    // way to act on - and whose only obvious action, re-sending, is the double
    // charge this whole mechanism exists to prevent.
    if (res.status === 409 && body?.error === 'intent_unresolved') {
      return await this.reconcile(intentId, to, amount);
    }

    // The DETAIL travels with a persona-facing reason and NEVER with a generic
    // one: `detail` is chain-svc's own prose about what it tried, which is the
    // half a persona needs when the refusal is about its own input, and the
    // half that would leak when the refusal is about anything else.
    const mapped = body?.error ? refusalFor(body.error, this.log) : null;
    if (mapped) {
      // The DETAIL travels with a persona-facing reason: it is chain-svc's own
      // prose about what it tried, and it is the half a persona needs when the
      // refusal is about its own wallet, policy or input.
      return this.fail(mapped, body?.detail);
    }
    // ⛔ NO DETAIL ON THE GENERIC PATH, and the code itself is a detail.
    // Passing `body.error` here would hand the persona the exact string the
    // generic mapping exists to withhold - `not_your_wallet`, `unknown_intent`,
    // `internal_error` - which is the whole disclosure decision undone by an
    // argument that looks like helpfulness. `refusalFor` has already logged the
    // real code for the facilitator; that is where it goes.
    return this.fail('error');
  }

  /// Polls GET /intents/:intentId until the reservation resolves or the budget
  /// runs out (spec S5). Never re-sends: the only safe move on an unresolved
  /// intent is to ASK, and asking is what this does.
  private async reconcile(intentId: string, to: string, vee: string): Promise<SendResult> {
    const deadline = Date.now() + RECONCILE_BUDGET_MS;

    while (Date.now() < deadline) {
      const res = await this.client.intent(intentId);
      if (res.outcome === 'response' && res.status === 200) {
        const body = res.body as { status?: string; txHash?: string } | null;

        if (body?.status === 'confirmed' && body.txHash) {
          // It DID happen. Recording it now is what makes a persona's re-send
          // return this same hash instead of moving money a second time.
          this.store.remember(intentId, { txHash: body.txHash, vee, to, at: Date.now() });
          return { ok: true, txHash: body.txHash };
        }
        if (body?.status === 'failed') {
          return this.fail('error', `the transfer to ${to} was broadcast and reverted; no ${this.symbol} moved`);
        }
        // reserved or broadcast: not settled yet. Keep waiting.
      }
      await new Promise((r) => setTimeout(r, RECONCILE_INTERVAL_MS));
    }

    // Still unresolved. This is the ONE case the model sees, and it is told the
    // only correct next step - which is not to send again.
    return this.fail(
      'intent_unresolved',
      `the send to ${to} is unresolved after ${RECONCILE_BUDGET_MS / 1000}s. Do NOT re-send. ` +
        `Retrying with the SAME intent_id ${intentId} is safe and returns the original outcome.`,
    );
  }
}
