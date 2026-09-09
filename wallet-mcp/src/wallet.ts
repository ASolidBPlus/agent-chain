// The tools' behaviour, with no MCP in it, so org-core can import this package
// as a library and so the tests exercise the logic rather than a transport.

import { ChainSvcClient, type CallResult } from './client.ts';
import type { WalletConfig } from './config.ts';
import { checkLocally, normaliseVee, readPolicy, type Refusal } from './policy.ts';
import { WalletStore } from './store.ts';

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
/// Ten seconds, ruled 01:15 UTC. Long enough for a receipt on an instant-mining
/// chain, short enough that a tool call still returns.
const RECONCILE_BUDGET_MS = 10_000;

const RECONCILE_INTERVAL_MS = 250;

/// chain-svc error code -> the reason a persona sees. Exported so a root test
/// can check every key against the codes chain-svc actually emits: a typo or a
/// retired code here degrades silently into `error`, which tells the model
/// nothing and is indistinguishable from a genuine fault.
export const REFUSAL_FOR: Record<string, Refusal> = {
  over_max_per_tx: 'over_max_per_tx',
  over_stage_cap: 'over_stage_cap',
  counterparty_denied: 'counterparty_denied',
  unknown_name: 'unknown_name',
  ambiguous_name: 'ambiguous_name',
  wallet_frozen: 'frozen',
};

export class Wallet {
  private readonly client: ChainSvcClient;
  private readonly store: WalletStore;

  constructor(private readonly config: WalletConfig) {
    this.client = new ChainSvcClient(config);
    this.store = new WalletStore(config.stateFile);
  }

  /// Strips the wallet token from anything on its way to the model.
  ///
  /// Nothing here should ever contain it - the token only goes into a request
  /// header - so this is the last line, not the first.
  ///
  /// This comment used to say, flatly, that mesh-agent's transcript redactor
  /// does not cover WALLET_TOKEN. True when written (S5 described a hardcoded
  /// list of two) and FALSE since their #18. Keeping the control was right; the
  /// reason had rotted.
  ///
  /// The mechanism, measured by mesh-agent-builder rather than reasoned about,
  /// after two wrong accounts of it - one of which was in this comment:
  /// mesh-agent redacts the values of ALLOWLISTED ENV VAR NAMES, whatever route
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
  /// The two that are true (ruled 00:09 UTC):
  ///
  ///   1. `org-core` imports this package AS A LIBRARY, not over stdio (S5).
  ///      There is no mesh-agent in that process at all, so there is no
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
  /// occur in ordinary text", and a long token can still have it - mesh-agent
  /// measured `password`, eight characters and past their floor, rewriting
  /// both occurrences in "a weak password ... password reuse". So do not read
  /// the threshold below as a safety line: it catches the obvious case, and a
  /// dictionary-word token of any length would still over-match. The real
  /// guarantee is upstream, in chain-svc issuing 32 random bytes.
  /// chain-svc issues 32-byte tokens, so anything short is a misconfiguration
  /// rather than a small secret - and mesh-agent's own transcript redactor
  /// silently declines to redact under 8 characters, so a short token is
  /// unprotected at that layer too. Warned rather than refused: this process
  /// does not get to decide that someone's deployment is invalid, only to say
  /// so. The VALUE is never logged, only its length.
  static warnIfImplausiblyShort(token: string, warn: (message: string) => void = console.error): void {
    if (token.length < 16) {
      warn(
        `wallet-mcp: WALLET_TOKEN is ${token.length} characters. chain-svc issues 32-byte tokens, ` +
          `so this is probably a misconfiguration; short values also make redaction over-match and ` +
          `are not redacted at all by mesh-agent's transcript layer below 8.`,
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
  > {
    const res = await this.client.resolve(name);
    const down = Wallet.unreachable(res);
    if (down || res.outcome !== 'response') return { error: this.redact(down ?? 'unknown_name') };
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
      // timestamp, so this is a block height. Flagged to powerout-planner -
      // chain-svc would have to read block timestamps to do better.
      when: entry.blockNumber,
      direction: entry.from === this.config.agentId ? 'out' : 'in',
      counterparty: entry.from === this.config.agentId ? entry.to : entry.from,
      vee: entry.vee,
      ...(entry.memo === undefined ? {} : { memo: entry.memo }),
    }));
  }

  async send(args: { to: unknown; vee: unknown; intent_id: unknown; memo?: unknown }): Promise<SendResult> {
    const to = typeof args.to === 'string' ? args.to.trim() : '';
    const intentId = typeof args.intent_id === 'string' ? args.intent_id.trim() : '';
    // `vee` IS A DECIMAL STRING on every money wire (ruled 03:55). A number is
    // tolerated only when it is an INTEGER, which is exactly representable and
    // has nothing to round; a non-integer number is REFUSED rather than
    // rounded, because silent rounding on an amount is the one outcome worth
    // more than the convenience. The tolerance exists because an LLM writes 50
    // as often as it writes "50" - it is not a second supported type.
    const vee = normaliseVee(args.vee);
    const memo = typeof args.memo === 'string' ? args.memo : undefined;

    if (to === '') return this.fail('error', 'to is required and must be a name');
    if (intentId === '') return this.fail('error', 'intent_id is required');
    if (vee === null) {
      return this.fail(
        'error',
        'vee must be a positive decimal string, e.g. "50" or "12.5". A whole number is accepted; ' +
          'a fractional number is not, because it cannot be carried exactly - send it as a string.',
      );
    }

    // Idempotence, and the one refusal only this side can see. A replay of the
    // SAME send returns the original result - the model retried, it did not
    // decide twice. Reusing an intent id for a DIFFERENT send is the mistake
    // `duplicate_intent` exists to name.
    const previous = this.store.recall(intentId);
    if (previous) {
      // The dedupe KEY is the intent id alone (ruled 03:55). These are not
      // key components - they are what makes "same id, different send" a
      // REFUSAL rather than a silent replay of the wrong transfer.
      if (previous.to === to && previous.vee === vee) {
        return { ok: true, txHash: previous.txHash };
      }
      return this.fail(
        'duplicate_intent',
        `intent_id ${intentId} was already used to send ${previous.vee} VEE to ${previous.to}`,
      );
    }

    // `to` ALWAYS goes through resolve (spec S5): it is a name, never an
    // address and never an id scraped from a message tag. A bare local id is
    // not registered, so it lands here as unknown_name.
    const resolved = await this.resolve(to);
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
      // wallet is registered as toby" while `arena:toby` exists and concludes
      // the registry is broken.
      //
      // Reconstructing that sentence locally would be a second authority for
      // one fact, and the two would drift the first time either side reworded
      // it. chain-svc already says exactly what it tried; this passes it
      // through and adds nothing.
      if (resolved.error === 'unknown_name' || resolved.error === 'ambiguous_name') {
        return this.fail(REFUSAL_FOR[resolved.error]!, resolved.detail ?? resolved.error);
      }
      return this.fail('error', resolved.error);
    }

    const local = checkLocally(readPolicy(this.config.policyFile), to, vee);
    if (local) return this.fail(local);

    const res = await this.client.signTransfer({ to, vee, intentId, ...(memo ? { memo } : {}) });

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
      this.store.remember(intentId, { txHash: body.txHash, vee, to, at: Date.now() });
      return { ok: true, txHash: body.txHash };
    }

    // The broadcast-to-record window is chain-svc's problem, not the model's
    // (spec S5). Reconcile here rather than handing a persona a state it has no
    // way to act on - and whose only obvious action, re-sending, is the double
    // charge this whole mechanism exists to prevent.
    if (res.status === 409 && body?.error === 'intent_unresolved') {
      return await this.reconcile(intentId, to, vee);
    }

    const mapped = body?.error ? REFUSAL_FOR[body.error] : undefined;
    return mapped ? this.fail(mapped, body?.detail) : this.fail('error', body?.error ?? `chain-svc returned ${res.status}`);
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
          return this.fail('error', `the transfer to ${to} was broadcast and reverted; no VEE moved`);
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
