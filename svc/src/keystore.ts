// Encrypted-at-rest wallet keys, one file per agent (spec S4).
//
// scrypt (KEYSTORE_SECRET) -> AES-256-GCM. GCM rather than CBC so a tampered
// key file fails to decrypt instead of yielding a plausible wrong key: this
// file IS the agent's ability to spend, and a silently corrupted one would
// present as an unexplained chain error.

import {
  randomBytes,
  scrypt as scryptCb,
  createCipheriv,
  createDecipheriv,
  type ScryptOptions,
} from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { HttpError } from './errors.ts';
import { keyFileName } from './validate.ts';

function scrypt(secret: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, keyLength, options, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

// N=2^15 costs ~33.5 MB (128*N*r), which is over node's 32 MB scrypt default -
// hence the explicit maxmem. Raising N later is a keystore format change: bump
// `version` and keep reading v1 files, or every existing wallet becomes
// unspendable.
const KDF = { N: 32768, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 } as const;

export interface KeyFile {
  version: 1;
  agentId: string;
  address: Address;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
  ciphertext: string;
}

async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return scrypt(secret, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem });
}

export class Keystore {
  constructor(
    private readonly dir: string,
    private readonly secret: string,
  ) {}

  private path(agentId: string): string {
    return join(this.dir, keyFileName(agentId));
  }

  async has(agentId: string): Promise<boolean> {
    try {
      await access(this.path(agentId));
      return true;
    } catch {
      return false;
    }
  }

  /// Creates a wallet and persists its encrypted key. Refuses to overwrite an
  /// existing file: a wallet whose key is replaced still owns its old balance
  /// and its registry names, and nothing on chain would show the swap.
  async create(agentId: string): Promise<{ address: Address; privateKey: Hex }> {
    if (await this.has(agentId)) {
      throw new HttpError('internal_error', 'refusing to overwrite an existing key file');
    }
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;

    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveKey(this.secret, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);

    const file: KeyFile = {
      version: 1,
      agentId,
      address,
      kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      ciphertext: ciphertext.toString('base64'),
    };

    // 0700/0600: the ciphertext is AES-256-GCM so this is defence in depth,
    // but this file is the agent's ability to spend and there is no reason for
    // it to be world-readable.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // wx: two concurrent spawns of the same agent must not both "win" and leave
    // one holding a key for an address the registry no longer points at.
    await writeFile(this.path(agentId), JSON.stringify(file, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return { address, privateKey };
  }

  async load(agentId: string): Promise<{ address: Address; privateKey: Hex }> {
    let raw: string;
    try {
      raw = await readFile(this.path(agentId), 'utf8');
    } catch {
      throw new HttpError('wallet_not_found', `no key file for ${agentId}`);
    }

    // Inside the try: a key file that is not JSON is a doctored or truncated
    // file, which is the same operator-visible problem as a wrong secret and
    // deserves the same labelled refusal - not a bare SyntaxError escaping to
    // a 500 with no diagnostic.
    let file: KeyFile;
    try {
      file = JSON.parse(raw) as KeyFile;
    } catch {
      throw new HttpError('internal_error', 'key file is not valid JSON');
    }
    if (file.version !== 1) {
      throw new HttpError('internal_error', `unsupported key file version ${file.version}`);
    }

    const salt = Buffer.from(file.kdf.salt, 'base64');
    const key = await scrypt(this.secret, salt, KDF.keyLength, {
      N: file.kdf.N,
      r: file.kdf.r,
      p: file.kdf.p,
      maxmem: KDF.maxmem,
    });

    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
    let privateKey: string;
    try {
      privateKey = decipher.update(Buffer.from(file.ciphertext, 'base64'), undefined, 'utf8') + decipher.final('utf8');
    } catch {
      // Wrong KEYSTORE_SECRET or a tampered file. Both are operator-visible
      // problems, and neither should look like "this agent has no wallet".
      throw new HttpError('internal_error', 'key file could not be decrypted');
    }

    const derived = privateKeyToAccount(privateKey as Hex).address;
    // The address is stored in the clear for lookups, so it is attacker-editable
    // if the volume is. Deriving it and comparing means a doctored file cannot
    // redirect a transfer to an address the key does not control.
    //
    // A PLAIN comparison, deliberately. This was timingSafeEqual, which throws
    // RangeError on a length mismatch - and `file.address` is whatever the JSON
    // says, so a short doctored value escaped as a RangeError instead of the
    // refusal written for exactly this case. The address is public and stored
    // beside the key, so constant-time buys nothing here; the secret in this
    // function is the private key, which is never compared.
    if (derived.toLowerCase() !== String(file.address).toLowerCase()) {
      throw new HttpError('internal_error', 'key file address does not match its private key');
    }
    return { address: derived, privateKey: privateKey as Hex };
  }
}
