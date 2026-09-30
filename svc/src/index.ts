// chain-svc entrypoint: validate the environment, prove the chain is the
// private one, then serve. Every failure here is fatal on purpose - a service
// that starts in a half-configured state holds every wallet key in the game.

import { loadConfig } from './config.ts';
import { Chain, assertPrivateChain, assertPrivateRpcUrl, loadDeployment } from './chain.ts';
import { describeModules } from './modules.ts';
import { Keystore } from './keystore.ts';
import { Store } from './store.ts';
import { ServicesHolder, createChainSvcServer } from './server.ts';
import { activate, loadAdminRecord, recordFullyOnChain } from './activate.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  // Before anything dials out: this must never emit a request to a public node.
  assertPrivateRpcUrl(config.rpcUrl);

  // CONTAINER MODE READS ITS RECORD FIRST, exactly where it always did: a
  // missing local.json is still reported before anything dials the chain, so
  // a stack that deploys with the boot container sees the same failure in the
  // same order as before.
  const containerRecord = config.deployMode === 'container' ? loadDeployment(config.deploymentsDir) : null;

  // BOOT: what exists before there is a deployment. The chain is checked to be
  // the private one - which needs no record - and nothing here can move money.
  const chain = new Chain(config);
  await assertPrivateChain(chain);
  const store = new Store(config.storePath);
  const keystore = new Keystore(config.keystoreDir, config.keystoreSecret);
  const holder = new ServicesHolder({ config, chain, store, keystore });

  if (containerRecord !== null) {
    // Every check runs before the server listens, and a failure exits here
    // with nothing served - as before.
    await activate(holder, containerRecord);
  } else {
    // ADMIN MODE: activate a record this service wrote earlier, if there is one.
    const adminRecord = loadAdminRecord(config);
    if (adminRecord !== null) {
      try {
        await activate(holder, adminRecord);
      } catch (err) {
        // THE ONE BOOT FAILURE THE DEPLOY ROUTE CAN REPAIR is a chain reset
        // beneath the record - some recorded address holding no code - and that
        // is measured here rather than inferred from which step threw. Anything
        // else is a real refusal and exits, as it would in container mode: a
        // replaced chain under a live store, a wiped ledger, a wrong mnemonic.
        if (await recordFullyOnChain(chain, adminRecord)) throw err;
        const code = (err as { code?: unknown })?.code;
        console.warn(
          `chain-svc: ${typeof code === 'string' ? `${code} - ` : ''}the recorded deployment is not on ` +
            `this chain; serving not-deployed until POST /admin/deploy redeploys it ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  const server = createChainSvcServer(holder);
  server.listen(config.port, '0.0.0.0', () => {
    const active = holder.current;
    console.log(
      active === null
        ? `chain-svc listening on :${config.port} (not deployed; DEPLOY_MODE=admin, POST /admin/deploy to deploy)`
        : `chain-svc listening on :${config.port} (chain ${chain.deployment.chainId}, ` +
            `treasury ${chain.deployment.treasury}, modules ${describeModules(chain.modules)}, ` +
            `events -> ${config.hubCoreUrl ?? 'buffered, no HUB_CORE_URL set'})`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`chain-svc: ${signal}, shutting down`);
    holder.events?.stop();
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
