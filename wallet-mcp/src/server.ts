#!/usr/bin/env bun
// The stdio MCP server one agent talks to (spec S5).
//
// TOOL NAMES ARE BARE HERE - `send`, `balance`, `whoami`, `history`, `resolve`.
// the harness prefixes every tool with its server name (src/mcp.ts:
// `${server.name}_${t.name}`), so registering this server as "wallet" is what
// produces S5's model-visible `wallet_send`. Declaring `wallet_send` here would
// reach the model as `wallet_wallet_send`; the harness prefixes tool names.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadWalletConfig } from './config.ts';
import { Wallet, type LogSink } from './wallet.ts';
import { defaultTokenOf, fetchModules, type ModulesReply } from './modules.ts';

function asToolResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/// Tools are advertised by the modules a deployment actually has (spec S5):
/// `whoami` always; the money tools (`balance`, `history`, `send`) only when a
/// default token exists; `resolve` only when a names module does. A model never
/// sees a tool whose module is absent, so the `module_not_deployed` path stays
/// unreachable rather than surfacing as a refusal.
export function buildServer(wallet: Wallet, modules: ModulesReply): McpServer {
  const server = new McpServer({ name: 'wallet', version: '0.1.0' });

  server.registerTool(
    'whoami',
    {
      description:
        'Who this wallet belongs to: its game-assigned agent id, its address, any vanity names pointing ' +
        'at it, and the tokens this deployment carries, by symbol.',
      inputSchema: {},
    },
    async () => asToolResult(await wallet.whoami()),
  );

  const token = defaultTokenOf(modules);
  if (token) {
    const symbol = token.symbol;
    // BOTH FORMS, named from the live registry. A persona reads symbols in every
    // reply, so it must be able to write one back; the key is what the manifest
    // and chain-svc's bookkeeping use. `resolveTokenOrRefusal` accepts either,
    // case-insensitively, and the description says so rather than advertising
    // one form and accepting the other.
    const tokenArg =
      'which token, as either its key or its symbol, case-insensitive: ' +
      modules.tokens.map((t) => `${t.key} (${t.symbol})`).join(', ') +
      `. Omit it for the default, ${symbol}.`;

    server.registerTool(
      'balance',
      {
        description:
          `Every token this wallet holds, each at its own precision. The default is ${symbol}; ` +
          'a balance is reported under the token\'s SYMBOL.',
        inputSchema: {},
      },
      async () => asToolResult(await wallet.balance()),
    );

    server.registerTool(
      'history',
      {
        description:
          `Recent movements for this wallet, newest first, in ONE token - ${symbol} unless you ` +
          'name another. Amounts in different tokens are not merged, because they are not in the ' +
          'same units.',
        inputSchema: {
          limit: z.number().int().positive().max(200).optional(),
          token: z.string().optional().describe(tokenArg),
        },
      },
      async ({ limit, token: tok }) => asToolResult(await wallet.history(limit ?? 20, tok)),
    );

    server.registerTool(
      'send',
      {
        description:
          `Send a token to a NAME - never an address, and never an id copied out of a message header. ` +
          `Defaults to ${symbol} when you do not name a token. ` +
          'Spending is bounded by this wallet\'s policy, PER TOKEN; a refusal comes back as {ok:false, reason} ' +
          'where the reason is one of over_max_per_tx (a smaller amount would work), no_cap_set ' +
          '(your policy sets no bound for that token, so no amount will), over_stage_cap, ' +
          'counterparty_denied, unknown_name, ambiguous_name, unknown_token, frozen, ' +
          'duplicate_intent. Reuse the same intent_id when retrying the SAME payment: it will not be sent twice - ' +
          'but reusing it for a different token is a different payment and is refused.',
        inputSchema: {
          to: z.string().describe(
            // SAYS WHAT THE ARGUMENT IS, not what it is not. The previous
            // wording named the fabric a persona does not need to know about to
            // use the tool, and a description spent on exclusions is a
            // description not spent on the form the model has to produce.
            'the recipient NAME - a registered name, never an address. Canonical form is ' +
            '<org>:<agent id> — for example "acme:toby" for the agent you see as "toby". ' +
            'A vanity alias also works. A bare id with no prefix is looked up inside your own org, ' +
            'so "toby" means "acme:toby" - but send the full form: a bare id is refused as ' +
            'ambiguous_name when a registered name is spelled the same way, and as unknown_name when ' +
            'neither exists.',
          ),
          token: z.string().optional().describe(tokenArg),
          // A DECIMAL STRING is the contract (ruled). A whole number is
          // accepted because a model writes 50 as readily as "50", and an integer
          // is exactly representable so nothing rounds. A fractional number is
          // refused rather than rounded - see normaliseVee. The amount is in the
          // NAMED token's own precision, which is why the token is resolved
          // before it is scaled.
          amount: z
            .union([z.string(), z.number()])
            .describe(
              'how much to send, as a decimal string, e.g. "50" or "12.5". A whole number is also ' +
              `accepted. In the NAMED token's own units - ${symbol} unless you name another.`,
            ),
          intent_id: z.string().describe('a stable id for this payment; retrying with it will not double-spend'),
          memo: z.string().optional().describe('what the payment is for'),
        },
      },
      async (args) => asToolResult(await wallet.send(args)),
    );
  }

  if (modules.names) {
    server.registerTool(
      'resolve',
      {
        description:
          // The suffix comes from the DEPLOYMENT, not from a literal: it is a
          // manifest field now, so a hardcoded example is wrong on any
          // deployment that chose a different one - and wrong in the worst
          // place, since this is the text the model reads to learn what a name
          // looks like. Inside `if (modules.names)`, so it is present here by
          // construction.
          `Look up a name - a canonical agent id like alpha:client, or a vanity alias like alpha.${modules.names.tld} - ` +
          'and get the address and canonical id it points at. Two names that look alike can point at different ' +
          'wallets, so resolve a name before trusting it.',
        inputSchema: { name: z.string().describe('the name to look up') },
      },
      async ({ name }) => asToolResult(await wallet.resolve(name)),
    );
  }

  // §4. THE GENERIC CALL OP — ALWAYS REGISTERED, unlike the money tools.
  //
  // They need no module: an empty allowlist yields an empty menu, and a persona
  // that asks what it may call and is told "nothing" has learned something
  // true. A persona whose tool is simply absent has learned nothing, and the
  // absence is indistinguishable from a deployment where the op does not exist.
  // EVERY refusal a call can actually produce. over_max_per_tx and
  // counterparty_denied were missing, and both are reachable: a call whose
  // amount is in the default token goes through the same enforcePolicy as a
  // send, with the CONTRACT KEY as the counterparty. A description that omits a
  // refusal the persona will meet is a description that teaches it to treat
  // that refusal as an unknown error.
  const REFUSALS =
    'Refusals you may see: unknown_contract, function_not_allowed, bad_args, revert, ' +
    'over_max_per_tx, over_stage_cap, counterparty_denied, frozen, duplicate_intent.';

  server.registerTool(
    'contracts',
    {
      description:
        'What this wallet may call on chain: contracts, functions, and the shape of their arguments. ' +
        'Names, never addresses. Read this before calling anything - it is the only place that says ' +
        'which arguments are names, which are token keys, and which are amounts.',
      inputSchema: {},
    },
    async () => asToolResult(await wallet.contracts()),
  );

  server.registerTool(
    'call',
    {
      description:
        'Call a function on a contract, signed with this wallet. Use `contracts` first to see what is ' +
        'callable and what each argument takes. Money moved by a call is bounded by this wallet\'s ' +
        `policy exactly as a send is. ${REFUSALS} ` +
        'Reuse the same intent_id when retrying the SAME call: it will not be made twice.',
      inputSchema: {
        contract: z.string().describe('the contract KEY from `contracts`, e.g. "converter" - never an address'),
        function: z.string().describe('the function name, exactly as `contracts` lists it'),
        args: z
          .array(
            z.union([
              z.string(),
              z.boolean(),
              z.object({ token: z.string() }),
              z.object({ contract: z.string() }),
              z.object({ name: z.string() }),
            ]),
          )
          .describe(
            'the arguments, in the order `contracts` lists them. Numbers and amounts are DECIMAL ' +
              'STRINGS ("40", not 40). An address argument is never an address: pass {"token":"gold"} ' +
              'for a token, {"contract":"shop"} for a contract, or {"name":"acme:toby"} for a wallet, ' +
              'as `contracts` says for that argument.',
          ),
        intent_id: z.string().describe('a stable id for this call; retrying with it will not call twice'),
      },
    },
    async (args) => asToolResult(await wallet.call(args)),
  );

  server.registerTool(
    'read',
    {
      description:
        'Read a view function on a contract. Free, changes nothing, and safe to call before deciding - ' +
        'if you are unsure whether a call would work, read first. ' +
        'Refusals you may see: unknown_contract, function_not_allowed, bad_args, revert.',
      inputSchema: {
        contract: z.string().describe('the contract KEY from `contracts`'),
        function: z.string().describe('the function name, exactly as `contracts` lists it'),
        args: z
          .array(
            z.union([
              z.string(),
              z.boolean(),
              z.object({ token: z.string() }),
              z.object({ contract: z.string() }),
              z.object({ name: z.string() }),
            ]),
          )
          .describe('the arguments, in the order `contracts` lists them; [] for a function that takes none'),
      },
    },
    async (args) => asToolResult(await wallet.read(args)),
  );

  return server;
}

/// STDIO MODE'S SINK. wallet-mcp IS the process here, so stderr is its own -
/// no other package shares it, and the harness above treats it as diagnostics.
/// This is the one place that gets to make that assumption, which is why the
/// library takes a sink instead of reaching for one (#99).
const stderrLog: LogSink = (message) => {
  process.stderr.write(`${message}\n`);
};

async function main(): Promise<void> {
  const config = loadWalletConfig();
  Wallet.warnIfImplausiblyShort(config.walletToken, stderrLog);
  // Read the deployed module set once, before building the server: it decides
  // which tools to advertise and carries the default token's symbol/decimals.
  // Unreachable or non-200 throws here and the catch below exits non-zero.
  const modules = await fetchModules(config);
  const server = buildServer(new Wallet(config, { log: stderrLog, modules }), modules);
  await server.connect(new StdioServerTransport());
  // Never log the config: WALLET_TOKEN is in it and stderr reaches the harness.
  //
  // The reason is NOT that the harness's redactor misses that variable - this
  // comment used to say so, and it stopped being true at their #18. Measured
  // mechanism: the harness redacts the values of ALLOWLISTED env var names,
  // whatever route the credential took. See the long note in wallet.ts, which
  // is where this was corrected; the same rotten claim survived here, in the
  // file an operator actually reads to decide whether logging the config is
  // safe. Two true reasons, both still standing: org-core imports Wallet as a
  // LIBRARY with no harness redactor anywhere in the process, and whether
  // WALLET_TOKEN is allowlisted is a property of a DEPLOYMENT that this process
  // cannot observe. Neither is something to bet a treasury credential on.
  console.error(`wallet-mcp ready for ${config.agentId}`);
}

// Only when run as a process. org-core imports Wallet directly.
if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
