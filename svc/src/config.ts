// Environment configuration. Every value is required and validated at startup:
// this process holds every wallet key in the game, and a missing secret that
// defaults to "" fails later as a 401 from somewhere else, which is a config
// error wearing an auth error's clothes.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.ts';
import { assertPrivateRpcUrl } from './chain.ts';

/// Ships with the package, so the defaults travel with the code that reads
/// them rather than depending on a mount being present.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  port: number;
  rpcUrl: string;
  /// Bearer token every caller must present. Also the bearer chain-svc uses
  /// when POSTing to hub-core's /events (spec S4).
  ///
  /// THE COST OF THAT SHARING, stated because it is deliberate and not free:
  /// this one secret authorises moving the game's money, and chain-svc SENDS it
  /// to whatever answers at HUB_CORE_URL. A wrong or hostile value there does
  /// not merely lose events - it is handed a platform-scope credential. That is
  /// why HUB_CORE_URL is validated as strictly as RPC_URL rather than defaulted
  /// to an empty string: an unvalidated destination for this header is an
  /// exfiltration path with a config typo as its trigger.
  ///
  /// Splitting it into a separate outbound token is the right fix and belongs
  /// with C5, when hub-core exists to hold the other half.
  token: string;
  /// Passphrase for the scrypt KDF that encrypts each wallet key file.
  keystoreSecret: string;
  /// The BIP-39 phrase the chain was started with. Account 0 of it is the
  /// deployer AND the treasury (spec S2). Derived in memory at startup and
  /// never written to disk - it is the one key that can mint.
  anvilMnemonic: string;
  keystoreDir: string;
  /// Where chain-svc writes each agent's policy file for wallet-mcp to read.
  policyDir: string;
  storePath: string;
  acknowledgeLedgerReset: boolean;
  acknowledgeChainReset: boolean;
  /// Per-`kind` policy caps applied when POST /wallets carries no explicit
  /// policy. Provisional game balance, tuned by the game owner - deliberately a
  /// file rather than a constant in the code (ruled).
  /// OPT-IN as of v0.8.0: unset means NO KIND DEFAULTS AT ALL, not "use the
  /// shipped file". The file that ships is `policy-defaults.example.json` and
  /// nothing loads it - a deployment that wants kind defaults mounts one and
  /// points `POLICY_DEFAULTS_FILE` at it.
  ///
  /// It was a baked-in path with the shipped file as its default, so every
  /// deployment enforced one game's balance numbers whether or not its operator
  /// had ever seen them.
  policyDefaultsPath?: string;
  deploymentsDir: string;
  /// hub-core's outcome feed. Unset is legitimate until C5 exists - events are
  /// buffered and retried rather than dropped (spec S4). SET-BUT-JUNK is not
  /// legitimate, and is rejected at startup; see `token` for why.
  hubCoreUrl?: string;
}

/// Unset means "no hub-core yet" and is fine. Set means chain-svc will send it
/// the token that authorises moving the game's money, so it must be a private
/// http(s) destination and nothing else - the same rule RPC_URL gets, for the
/// same reason.
export function hubCoreUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`chain-svc: HUB_CORE_URL ${value} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`chain-svc: HUB_CORE_URL ${value} must be http or https, not ${url.protocol}`);
  }

  // Reuses RPC_URL's private-host rule verbatim rather than restating it: two
  // copies of "what counts as private" drift, and this one carries the token.
  try {
    assertPrivateRpcUrl(value);
  } catch {
    throw new Error(
      `chain-svc: refusing_public_hub_core - HUB_CORE_URL ${value} is not a private host. ` +
        `chain-svc sends CHAIN_SVC_TOKEN there, and that token authorises moving the game's money.`,
    );
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `chain-svc: ${name} is unset or empty - refusing to start. ` +
        `It is a per-deployment secret from the hub .env (spec S10).`,
    );
  }
  return value;
}

/// AN ABSENT FALLBACK IS A FALLBACK. The overload exists so an optional
/// setting with no default reads the same way as one with a default: `||
/// undefined` looked equivalent and was not, because it treats `"   "` as a
/// value while every neighbour treats it as unset - so a whitespace
/// POLICY_DEFAULTS_FILE became a path of spaces and failed at load.
function optional(name: string, fallback: string): string;
function optional(name: string, fallback?: undefined): string | undefined;
function optional(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

export function loadConfig(env = process.env): Config {
  const previous = process.env;
  process.env = env;
  try {
    const port = Number(optional('PORT', '7000'));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`chain-svc: PORT must be a valid port number, got ${optional('PORT', '7000')}`);
    }
    return {
      port,
      rpcUrl: optional('RPC_URL', 'http://chain:8545'),
      // The operator stating they intend to end this game's idempotency
      // lifetime. Accepted from BOTH a flag and the environment because the
      // refusal it releases has to be clearable in compose, where nobody types
      // a command line, as well as from run.sh where somebody does.
      acknowledgeLedgerReset:
        process.argv.includes('--acknowledge-ledger-reset') ||
        optional('CHAIN_SVC_ACKNOWLEDGE_LEDGER_RESET', '') === '1',
      // The operator saying "I know the chain was replaced under this store".
      // It permits ONE boot and repairs nothing - see deployment.ts.
      acknowledgeChainReset:
        process.argv.includes('--acknowledge-chain-reset') ||
        optional('CHAIN_SVC_ACKNOWLEDGE_CHAIN_RESET', '') === '1',
      token: required('CHAIN_SVC_TOKEN'),
      keystoreSecret: required('KEYSTORE_SECRET'),
      anvilMnemonic: required('ANVIL_MNEMONIC'),
      keystoreDir: optional('KEYSTORE_DIR', '/keystore'),
      policyDir: optional('POLICY_DIR', '/policies'),
      storePath: optional('STORE_PATH', '/store/chain-svc.sqlite'),
      policyDefaultsPath: optional('POLICY_DEFAULTS_FILE'),
      deploymentsDir: optional('DEPLOYMENTS_DIR', '/deployments'),
      hubCoreUrl: hubCoreUrl(process.env.HUB_CORE_URL),
    };
  } finally {
    process.env = previous;
  }
}

/// Constant-time bearer comparison (spec S4). A length-varying or
/// short-circuiting compare leaks the token one byte at a time to anything that
/// can time it, and this token authorises moving the game's money.
export function assertAuthorized(header: string | undefined, expected: string): void {
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) throw new HttpError('unauthorized');
  const presented = header.slice(prefix.length);

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // length oracle - so fold the length difference into the result instead.
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  if (diff !== 0) throw new HttpError('unauthorized');
}
