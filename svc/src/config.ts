// Environment configuration. Every value is required and validated at startup:
// this process holds every wallet key in the game, and a missing secret that
// defaults to "" fails later as a 401 from somewhere else, which is a config
// error wearing an auth error's clothes.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.ts';

/// Ships with the package, so the defaults travel with the code that reads
/// them rather than depending on a mount being present.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  port: number;
  rpcUrl: string;
  /// Bearer token every caller must present. Also the bearer chain-svc uses
  /// when POSTing to hub-core's /events (spec S4).
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
  /// Per-`kind` policy caps applied when POST /wallets carries no explicit
  /// policy. Provisional game balance, tuned by the game owner - deliberately a
  /// file rather than a constant in the code (ruled 20:49 UTC).
  policyDefaultsPath: string;
  deploymentsDir: string;
  /// hub-core's outcome feed. Unset is legitimate until C5 exists - events are
  /// buffered and retried rather than dropped (spec S4).
  hubCoreUrl?: string;
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

function optional(name: string, fallback: string): string {
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
      token: required('CHAIN_SVC_TOKEN'),
      keystoreSecret: required('KEYSTORE_SECRET'),
      anvilMnemonic: required('ANVIL_MNEMONIC'),
      keystoreDir: optional('KEYSTORE_DIR', '/keystore'),
      policyDir: optional('POLICY_DIR', '/policies'),
      storePath: optional('STORE_PATH', '/store/chain-svc.sqlite'),
      policyDefaultsPath: optional('POLICY_DEFAULTS_FILE', join(PACKAGE_ROOT, 'policy-defaults.json')),
      deploymentsDir: optional('DEPLOYMENTS_DIR', '/deployments'),
      hubCoreUrl: process.env.HUB_CORE_URL?.trim() || undefined,
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
