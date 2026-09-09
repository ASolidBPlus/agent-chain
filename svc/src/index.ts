// chain-svc entrypoint: validate the environment, prove the chain is the
// private one, then serve. Every failure here is fatal on purpose - a service
// that starts in a half-configured state holds every wallet key in the game.

import { loadConfig } from './config.ts';
import { Chain, assertPrivateChain, assertPrivateRpcUrl, loadDeployment } from './chain.ts';
import { Keystore } from './keystore.ts';
import { Resolver } from './resolver.ts';
import { loadPolicyDefaults } from './policy.ts';
import { Spawner } from './spawn.ts';
import { Store } from './store.ts';
import { assertLedgerLifetimeIntact, gatherLifetimeFacts } from './migrate.ts';
import { Treasury } from './treasury.ts';
import { EventTail } from './events.ts';
import { createChainSvcServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  // Before anything dials out: this must never emit a request to a public node.
  assertPrivateRpcUrl(config.rpcUrl);

  const deployment = loadDeployment(config.deploymentsDir);
  const chain = new Chain(config, deployment);

  await assertPrivateChain(chain);

  const store = new Store(config.storePath);
  const keystore = new Keystore(config.keystoreDir, config.keystoreSecret);

  // BEFORE the service accepts a single request. A store-only wipe leaves this
  // process able to sign transfers for wallets whose consumed intent ids it has
  // forgotten and whose freezes it has released, so the check has to be a
  // precondition of starting rather than a warning printed beside it.
  //
  // `getCode` rather than the deployments file: the file says what was deployed
  // once, and the question here is what is on the chain NOW. A file describing
  // a chain that has been reset is exactly the stale artefact this control must
  // not be fooled by.
  assertLedgerLifetimeIntact(
    await gatherLifetimeFacts({
      store,
      keystore,
      getCode: () => chain.publicClient.getCode({ address: deployment.VEEBux }),
      acknowledged: config.acknowledgeLedgerReset,
    }),
  );
  const resolver = new Resolver(chain);
  const services = {
    config,
    chain,
    resolver,
    store,
    keystore,
    spawner: new Spawner(config, chain, keystore, store, resolver),
    treasury: new Treasury(config, chain, keystore, store, resolver, loadPolicyDefaults(config.policyDefaultsPath)),
  };

  // Started before the server accepts requests, so a transfer cannot happen
  // before there is anything reading the log for it.
  const events = new EventTail(config, chain, store);
  await events.pollOnce().catch((err) => console.warn('chain-svc: initial event poll failed', err.message));
  events.start();

  const server = createChainSvcServer(services);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(
      `chain-svc listening on :${config.port} (chain ${deployment.chainId}, ` +
        `VEEBux ${deployment.VEEBux}, treasury ${deployment.treasury}, ` +
        `events -> ${config.hubCoreUrl ?? 'buffered, no HUB_CORE_URL set'})`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`chain-svc: ${signal}, shutting down`);
    events.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // A refusal carries a machine-readable code as well as its prose, so an
  // operator or a log search can find the CAUSE without parsing a paragraph.
  // "Refuse by name" is the requirement; the name has to reach the log.
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') console.error(`chain-svc: ${code}`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
