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
        'Who this wallet belongs to: its game-assigned agent id, its address, and any vanity names pointing at it.',
      inputSchema: {},
    },
    async () => asToolResult(await wallet.whoami()),
  );

  const token = defaultTokenOf(modules);
  if (token) {
    const symbol = token.symbol;

    server.registerTool(
      'balance',
      { description: `How much ${symbol} this wallet holds.`, inputSchema: {} },
      async () => asToolResult(await wallet.balance()),
    );

    server.registerTool(
      'history',
      {
        description: `Recent ${symbol} movements for this wallet, newest first.`,
        inputSchema: { limit: z.number().int().positive().max(200).optional() },
      },
      async ({ limit }) => asToolResult(await wallet.history(limit ?? 20)),
    );

    server.registerTool(
      'send',
      {
        description:
          `Send ${symbol} to a NAME - never an address, and never an id copied out of a message header. ` +
          'Spending is bounded by this wallet\'s policy; a refusal comes back as {ok:false, reason} where the ' +
          'reason is one of over_max_per_tx, over_stage_cap, counterparty_denied, unknown_name, ' +
          'ambiguous_name, frozen, ' +
          'duplicate_intent. Reuse the same intent_id when retrying the SAME payment: it will not be sent twice.',
        inputSchema: {
          to: z.string().describe(
            'the recipient NAME, not a mesh id and not an address. Canonical form is ' +
            '<org>:<agent id> — for example "acme:toby" for the agent you see as "toby". ' +
            'A vanity alias also works. A bare id with no prefix is looked up inside your own org, ' +
            'so "toby" means "acme:toby" - but send the full form: a bare id is refused as ' +
            'ambiguous_name when a registered name is spelled the same way, and as unknown_name when ' +
            'neither exists.',
          ),
          // A DECIMAL STRING is the contract (ruled). A whole number is
          // accepted because a model writes 50 as readily as "50", and an integer
          // is exactly representable so nothing rounds. A fractional number is
          // refused rather than rounded - see normaliseVee.
          vee: z
            .union([z.string(), z.number()])
            .describe(`amount in ${symbol} as a decimal string, e.g. "50" or "12.5". A whole number is also accepted.`),
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
