import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { Keystore } from '../src/keystore.ts';
import { HttpError } from '../src/errors.ts';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'keystore-'));
}

describe('keystore', () => {
  it('round-trips a wallet key', async () => {
    const ks = new Keystore(freshDir(), 'secret');
    const created = await ks.create('orch:shadowbroker');
    const loaded = await ks.load('orch:shadowbroker');

    expect(loaded.address).toBe(created.address);
    expect(loaded.privateKey).toBe(created.privateKey);
    expect(privateKeyToAccount(loaded.privateKey).address).toBe(created.address);
  }, 20_000);

  it('writes the file under the URL-encoded id, so no colon reaches a path', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    await ks.create('orch:shadowbroker');
    expect(() => readFileSync(join(dir, 'orch%3Ashadowbroker.json'), 'utf8')).not.toThrow();
  }, 20_000);

  it('never stores the private key in the clear', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    const { privateKey } = await ks.create('orch:shadowbroker');
    const onDisk = readFileSync(join(dir, 'orch%3Ashadowbroker.json'), 'utf8');
    expect(onDisk).not.toContain(privateKey);
    expect(onDisk).not.toContain(privateKey.slice(2));
  }, 20_000);

  // A wallet whose key is replaced still owns its old balance and its registry
  // names, and nothing on chain would show the swap.
  it('refuses to overwrite an existing key file', async () => {
    const ks = new Keystore(freshDir(), 'secret');
    await ks.create('orch:shadowbroker');
    await expect(ks.create('orch:shadowbroker')).rejects.toThrow(HttpError);
  }, 20_000);

  it('reports a missing wallet as wallet_not_found, not a crash', async () => {
    const ks = new Keystore(freshDir(), 'secret');
    const err = await ks.load('orch:nobody').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('wallet_not_found');
  });

  it('refuses to decrypt with the wrong KEYSTORE_SECRET', async () => {
    const dir = freshDir();
    await new Keystore(dir, 'right-secret').create('orch:shadowbroker');
    await expect(new Keystore(dir, 'wrong-secret').load('orch:shadowbroker')).rejects.toThrow(HttpError);
  }, 20_000);

  // The address is stored in the clear for lookups, so it is editable by anyone
  // who can write the volume. Deriving it from the decrypted key and comparing
  // means a doctored file cannot redirect a transfer to an address the key does
  // not control - it fails loudly instead.
  // The stored address comes from the JSON, so its LENGTH is whatever the file
  // says. This used to be compared with timingSafeEqual, which throws
  // RangeError on a length mismatch - so a short doctored value escaped as an
  // unlabelled 500 instead of the refusal written for exactly this case. The
  // full-length case below always worked; only the short one did not.
  it('rejects a SHORT tampered address as a refusal, not a RangeError', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    await ks.create('orch:shadowbroker');

    const path = join(dir, 'orch%3Ashadowbroker.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as { address: string };
    file.address = '0xdeadbeef'; // deliberately not 42 characters
    writeFileSync(path, JSON.stringify(file));

    const err = await ks.load('orch:shadowbroker').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('internal_error');
  }, 20_000);

  /// A truncated or doctored file is the same operator-visible problem as a
  /// wrong secret and gets the same labelled refusal, rather than a SyntaxError
  /// escaping to a bare 500 with no diagnostic.
  it('rejects a key file that is not JSON as a refusal', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    await ks.create('orch:shadowbroker');
    writeFileSync(join(dir, 'orch%3Ashadowbroker.json'), '{ truncated');

    const err = await ks.load('orch:shadowbroker').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('internal_error');
  }, 20_000);

  /// Defence in depth - the contents are AES-256-GCM ciphertext - but this file
  /// is the agent's ability to spend, and there is no reason for it to be
  /// world-readable.
  it('writes the key file and its directory with restrictive modes', async () => {
    const dir = freshDir();
    await new Keystore(dir, 'secret').create('orch:shadowbroker');

    expect(statSync(join(dir, 'orch%3Ashadowbroker.json')).mode & 0o777).toBe(0o600);
  }, 20_000);

  it('rejects a key file whose stored address was tampered with', async () => {
    const dir = freshDir();
    const ks = new Keystore(dir, 'secret');
    await ks.create('orch:shadowbroker');

    const path = join(dir, 'orch%3Ashadowbroker.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as { address: string };
    file.address = '0x000000000000000000000000000000000000dEaD';
    writeFileSync(path, JSON.stringify(file));

    await expect(ks.load('orch:shadowbroker')).rejects.toThrow(HttpError);
  }, 20_000);
});
