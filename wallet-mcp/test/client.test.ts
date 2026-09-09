// The transport layer, whose only job is to answer one question honestly: did
// the request leave? An exception cannot answer it, which is why `call` returns
// data - and why the classification below is tested rather than assumed.

import { describe, it, expect } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { ChainSvcClient, classify } from '../src/client.ts';
import type { WalletConfig } from '../src/config.ts';

// Both shapes, because both occur: Node nests the code under `cause`, Bun puts
// it on the error itself. A helper that only built one of them is how the
// not_sent branch came to be unreachable while its unit tests passed.
const nodeErr = (code: string) => Object.assign(new Error('fetch failed'), { cause: { code } });
const bunErr = (code: string) => Object.assign(new Error('Unable to connect.'), { code });

describe('classifying a transport failure', () => {
  // Provable: no connection was ever established, so nothing was sent.
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL'])(
    'Node %s is not_sent, because it provably precedes any byte on the wire',
    (code) => {
      expect(classify(nodeErr(code)).outcome).toBe('not_sent');
    },
  );

  it.each(['ConnectionRefused', 'FailedToOpenSocket', 'ERR_INVALID_URL'])(
    'Bun %s is not_sent, read from err.code rather than err.cause.code',
    (code) => {
      expect(classify(bunErr(code)).outcome).toBe('not_sent');
    },
  );

  // NOT provable: every one of these can happen with a request in flight, so
  // calling them not_sent would license a retry that double-charges. The whole
  // design is pessimistic in this direction on purpose.
  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT', 'EPIPE'])(
    '%s is unknown, because a request may already be in flight',
    (code) => {
      expect(classify(nodeErr(code)).outcome).toBe('unknown');
      expect(classify(bunErr(code)).outcome).toBe('unknown');
    },
  );

  it('treats an unrecognised failure as unknown, not as not_sent', () => {
    expect(classify(new Error('something new')).outcome).toBe('unknown');
    expect(classify(null).outcome).toBe('unknown');
  });

  // An abort is the timeout firing: the request went out and no answer came.
  it('treats a timeout abort as unknown', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(classify(abort).outcome).toBe('unknown');
  });
});

function clientFor(url: string): ChainSvcClient {
  return new ChainSvcClient({
    agentId: 'orch:a',
    chainSvcUrl: url,
    walletToken: 'tok',
    policyFile: '/nonexistent',
    stateFile: '/nonexistent',
  } as WalletConfig);
}

describe('call never throws', () => {
  it('reports a refused connection as not_sent rather than raising', async () => {
    // Port 1 on loopback: nothing listens, and the refusal is immediate.
    const res = await clientFor('http://127.0.0.1:1').balance('orch:a');
    expect(res.outcome).toBe('not_sent');
  });

  it('reports a hung server as unknown, and RETURNS rather than hanging', async () => {
    // Accepts the connection and never answers - the case a backoff in a catch
    // cannot see, because a hang is not a rejection.
    const server: Server = createServer(() => {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      const res = await clientFor(`http://127.0.0.1:${port}`).balance('orch:a');
      expect(res.outcome).toBe('unknown');
    } finally {
      server.close();
    }
  }, 30_000);
});
