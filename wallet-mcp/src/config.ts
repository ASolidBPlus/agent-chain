// Startup configuration for one agent's wallet MCP.
//
// Every value is required and is validated here, loudly, because the harness
// cannot do it: the harness's ${VAR} expansion substitutes an unset variable
// with an EMPTY STRING, so a missing WALLET_TOKEN would otherwise reach
// chain-svc as an empty bearer and come back 401 - a config error wearing an
// auth error's clothes. wallet-mcp knows which of its variables are mandatory
// and the runtime never will, so the hard failure belongs here.

export interface WalletConfig {
  /// The QUALIFIED id, `<org label>:<local id>` (spec S0). the harness's own
  /// agentId is the bare local id; these are two renderings of one identity and
  /// this process only ever sees the qualified one.
  agentId: string;
  chainSvcUrl: string;
  /// This wallet's own credential (spec S4). Never CHAIN_SVC_TOKEN, which does
  /// not appear on the agent side at all.
  walletToken: string;
  policyFile: string;
  /// Where the dedupe ledger lives. Not in S5's env list - added here because
  /// intent dedupe has to survive a restart, or a retried send after a crash
  /// double-spends. Defaults beside the policy file.
  stateFile: string;
}

export const CLIENT_MARKER = 'wallet-mcp/0.1.0';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `wallet-mcp: ${name} is unset or empty - refusing to start. ` +
        `If it came from a \${${name}} reference in the agent config, the variable is not set ` +
        `in the container environment (the harness substitutes an empty string rather than failing).`,
    );
  }
  return value;
}

export function loadWalletConfig(env: NodeJS.ProcessEnv = process.env): WalletConfig {
  const policyFile = required(env, 'POLICY_FILE');
  return {
    agentId: required(env, 'WALLET_AGENT_ID'),
    chainSvcUrl: required(env, 'CHAIN_SVC_URL'),
    walletToken: required(env, 'WALLET_TOKEN'),
    policyFile,
    stateFile: env.WALLET_STATE_FILE?.trim() || policyFile.replace(/\.json$/, '') + '.state.json',
  };
}
