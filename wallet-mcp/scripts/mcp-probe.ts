// An MCP test client for spec S8 criterion 4: drives wallet-mcp over stdio, the
// same transport the harness uses, rather than calling the class directly.
// Exercised by verify-wallet.sh, which brings up the chain and chain-svc first.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}: ${a}`);
  else {
    console.log(`  FAIL ${label}: got ${a} want ${e}`);
    failures++;
  }
}

async function main(): Promise<void> {
  const client = new Client({ name: 'criterion-4-probe', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: 'bun',
      args: [join(PKG, 'src', 'server.ts')],
      env: process.env as Record<string, string>,
    }),
  );

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log('\n=== the tool names the harness will prefix');
  // The three call-op tools are registered UNCONDITIONALLY (call increment §4),
  // unlike the money and names tools, which appear only when their module does.
  // A persona told "nothing is callable" has learned something true; one whose
  // tool is simply absent has learned nothing.
  check('bare names', names, [
    'balance',
    'call',
    'contracts',
    'history',
    'read',
    'resolve',
    'send',
    'whoami',
  ]);
  console.log(`  the model sees: ${names.map((n) => `wallet_${n}`).join(', ')}`);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return JSON.parse(content.find((c) => c.type === 'text')?.text ?? 'null');
  };

  console.log('\n=== criterion 4');
  const before = await call('balance');
  console.log(`  balance before: ${JSON.stringify(before)}`);

  const first = await call('send', { to: 'alpha.play', amount: 50, intent_id: 'a1', memo: 'for the stream job' });
  check('send 50 accepted', first.ok, true);

  const replay = await call('send', { to: 'alpha.play', amount: 50, intent_id: 'a1' });
  check('replay returns the same txHash', replay.txHash, first.txHash);

  const afterReplay = await call('balance');
  // The balance tool answers `{balances, default}`, keyed by SYMBOL, since §3.
  // The symbol is read from the reply rather than written here: this probe runs
  // against whatever deployment verify-wallet.sh brought up, and a hardcoded
  // one would make the check pass or fail on the manifest rather than on the
  // money. It read `.vee` before that - a field the tool has never answered -
  // which compared `undefined` against `String(NaN)` and could never pass. It
  // went unnoticed because the script it lives in could not RUN: its deploy
  // died at the key scrape, so nothing downstream of that line was ever
  // reached. An instrument that cannot start reports nothing, including its own
  // broken assertions.
  const sym = before.default as string;
  check('the money moved once', afterReplay.balances[sym], String(Number(before.balances[sym]) - 50));

  check('150 is over max_per_tx', (await call('send', { to: 'alpha.play', amount: 150, intent_id: 'b1' })).reason, 'over_max_per_tx');

  // 50 + 4x100 = 450, under max_per_stage 500; the next 100 reaches 550.
  for (let i = 1; i <= 4; i++) {
    const r = await call('send', { to: 'alpha.play', amount: 100, intent_id: `s${i}` });
    if (r.ok !== true) {
      console.log(`  FAIL stage send ${i} should have been accepted: ${JSON.stringify(r)}`);
      failures++;
    }
  }
  console.log('  four sends of 100 accepted (stage total 450)');
  check('the fifth trips the stage cap', (await call('send', { to: 'alpha.play', amount: 100, intent_id: 's5' })).reason, 'over_stage_cap');

  check('treasury.play is denied', (await call('send', { to: 'treasury.play', amount: 1, intent_id: 'c1' })).reason, 'counterparty_denied');
  check('nobody.play is unknown', (await call('send', { to: 'nobody.play', amount: 1, intent_id: 'd1' })).reason, 'unknown_name');
  // Criterion 9 at the tool: a bare local id is not a name the ledger knows.
  check('a bare local id is unknown', (await call('send', { to: 'client', amount: 1, intent_id: 'd2' })).reason, 'unknown_name');

  console.log('\n=== §3: the tools say which token');
  // Every deployed token in the balance, and the default named. On a
  // single-token deployment this is a map of one, which is the point: the shape
  // does not change with the manifest.
  console.log(`  balances: ${JSON.stringify(before)}`);
  check('the default is one of the balances', Object.keys(before.balances).includes(sym), true);

  // The SAME token, named explicitly. Whatever the caller writes, the wire
  // carries the key - so this must behave exactly as the omitted form did.
  const named = await call('send', { to: 'alpha.play', amount: 1, token: sym, intent_id: 'tok1' });
  check('a send naming the default token is accepted', named.ok, true);
  check('a token this deployment lacks is refused', (await call('send', { to: 'alpha.play', amount: 1, token: 'NOSUCH', intent_id: 'tok2' })).reason, 'unknown_token');
  check('a token that is not a string is bad input', (await call('send', { to: 'alpha.play', amount: 1, token: 4, intent_id: 'tok3' })).reason, 'error');

  console.log('\n=== the other tools');
  const who = await call('whoami');
  check('whoami agentId', who.agentId, process.env.WALLET_AGENT_ID);
  check('whoami lists the deployed tokens', who.tokens.includes(sym), true);
  console.log(`  whoami: ${JSON.stringify(who)}`);
  const history = await call('history', { limit: 3 });
  console.log(`  history: ${JSON.stringify(history)}`);
  // One token per call, and every row says which.
  check('every history row names its token', (history as Array<{ token?: string }>).every((e) => e.token === sym), true);
  check('history for a token this deployment lacks is refused', typeof (await call('history', { limit: 3, token: 'NOSUCH' })).error, 'string');
  const lookalike = await call('resolve', { name: 'aIpha.play' });
  const real = await call('resolve', { name: 'alpha.play' });
  console.log(`  resolve aIpha.play -> ${JSON.stringify(lookalike)}`);
  console.log(`  resolve alpha.play -> ${JSON.stringify(real)}`);
  check('the lookalike is a different wallet', lookalike.address !== real.address, true);

  console.log('\n=== secret hygiene (spec S5): the token in no tool output');
  const everything = JSON.stringify([before, first, replay, named, who, history, lookalike, real]);
  check('token absent from every response', everything.includes(process.env.WALLET_TOKEN ?? 'x'), false);
  // Known-positive control: prove the matcher can see the token at all.
  check('control - the matcher can see it', JSON.stringify({ t: process.env.WALLET_TOKEN }).includes(process.env.WALLET_TOKEN ?? 'x'), true);

  await client.close();
  console.log(failures === 0 ? '\nPASS: criterion 4 over stdio MCP' : `\nFAIL: ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
