// chain-svc entrypoint: validate the environment, prove the chain is the
// private one, then serve. Every failure here is fatal on purpose - a service
// that starts in a half-configured state holds every wallet key in the game.

import { loadConfig } from './config.ts';
import { Chain, assertPrivateChain, assertPrivateRpcUrl, loadDeployment } from './chain.ts';
import { Resolver } from './resolver.ts';
import { Store } from './store.ts';
import { createChainSvcServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  // Before anything dials out: this must never emit a request to a public node.
  assertPrivateRpcUrl(config.rpcUrl);

  const deployment = loadDeployment(config.deploymentsDir);
  const chain = new Chain(config, deployment);

  await assertPrivateChain(chain);

  const store = new Store(config.storePath);
  const services = { config, chain, resolver: new Resolver(chain), store };

  const server = createChainSvcServer(services);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(
      `chain-svc listening on :${config.port} (chain ${deployment.chainId}, ` +
        `VEEBux ${deployment.VEEBux}, treasury ${deployment.treasury})`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`chain-svc: ${signal}, shutting down`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
