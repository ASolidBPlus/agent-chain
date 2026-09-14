// Startup validation. The harness cannot do this: the harness's ${VAR}
// expansion substitutes an UNSET variable with an empty string, so a missing
// WALLET_TOKEN would otherwise reach chain-svc as an empty bearer and come back
// 401 - a config error wearing an auth error's clothes.

import { describe, it, expect } from 'bun:test';
import { loadWalletConfig, CLIENT_MARKER } from '../src/config.ts';
import { Wallet } from '../src/wallet.ts';

const COMPLETE = {
  WALLET_AGENT_ID: 'orch:shadowbroker',
  CHAIN_SVC_URL: 'http://chain-svc:7000',
  // 32 chars, not the 7-char 'a-token' this used to be. the harness's
  // transcript redactor does not redact values under 8 characters (it warns,
  // loudly, naming the variable), and a short fixture is the one most likely to
  // be copied into a real config. chain-svc issues 32-byte tokens, so a
  // realistic fixture is also the honest one.
  WALLET_TOKEN: 'tok_0123456789abcdef0123456789',
  POLICY_FILE: '/policies/orch%3Ashadowbroker.json',
};

describe('configuration', () => {
  it('accepts a complete environment', () => {
    const config = loadWalletConfig({ ...COMPLETE });
    expect(config.agentId).toBe('orch:shadowbroker');
    expect(config.walletToken).toBe(COMPLETE.WALLET_TOKEN);
  });

  it('refuses each missing variable BY NAME', () => {
    for (const name of Object.keys(COMPLETE)) {
      const env = { ...COMPLETE } as Record<string, string>;
      delete env[name];
      expect(() => loadWalletConfig(env)).toThrow(new RegExp(name));
    }
  });

  // The empty string is the case that matters, because it is what an unset
  // ${VAR} becomes rather than what a careless operator types.
  it('treats an empty value as missing, not as a value', () => {
    for (const name of Object.keys(COMPLETE)) {
      expect(() => loadWalletConfig({ ...COMPLETE, [name]: '' })).toThrow(new RegExp(name));
      expect(() => loadWalletConfig({ ...COMPLETE, [name]: '   ' })).toThrow(new RegExp(name));
    }
  });

  it('never puts the token in the error it throws', () => {
    try {
      loadWalletConfig({ ...COMPLETE, POLICY_FILE: '' });
    } catch (err) {
      expect((err as Error).message).not.toContain(COMPLETE.WALLET_TOKEN);
    }
  });

  it('keeps the dedupe ledger beside the policy file by default', () => {
    expect(loadWalletConfig({ ...COMPLETE }).stateFile).toBe('/policies/orch%3Ashadowbroker.state.json');
    expect(loadWalletConfig({ ...COMPLETE, WALLET_STATE_FILE: '/tmp/s.json' }).stateFile).toBe('/tmp/s.json');
  });

  it('marks itself so chain-svc can tag the spend', () => {
    expect(CLIENT_MARKER).toMatch(/^wallet-mcp\/\d/);
  });
});

// the harness's transcript redactor declines to redact values under 8
// characters, and this process's own redact() gets WORSE as the token gets
// shorter - splitting on a two-letter value rewrites those letters wherever
// they appear. chain-svc issues 32-byte tokens, so short means misconfigured.
describe('an implausibly short token', () => {
  it('is warned about by length, never by value', () => {
    // A value that cannot occur in the message's prose. The first version used
    // 'short', which the warning legitimately contains as an English word - so
    // the assertion conflated the token VALUE with a description of it and
    // failed against correct behaviour.
    const warnings: string[] = [];
    Wallet.warnIfImplausiblyShort('qx7z', (m) => warnings.push(m));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('4 characters');
    expect(warnings[0]).toContain('WALLET_TOKEN');
    // The point of the warning is not to become the leak it warns about.
    expect(warnings[0]).not.toContain('qx7z');
  });

  it('says nothing about a realistic one', () => {
    const warnings: string[] = [];
    Wallet.warnIfImplausiblyShort('tok_0123456789abcdef0123456789', (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});
