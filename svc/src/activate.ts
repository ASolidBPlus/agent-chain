// Activation: everything chain-svc fixes from a deployment record.
//
// It was the body of the entrypoint, run once before the server listened. A
// service that deploys its own contracts has to start without a record and gain
// one while listening, so the same steps are one function called from two
// places - at boot when a record exists, and by the deploy route after it has
// written one - and there is no second copy of any check to drift.
//
// NOTHING IS SWAPPED UNTIL EVERY CHECK HAS PASSED. Each step either returns or
// throws a coded error, and the holder, `chain.deployment` and `chain.modules`
// change together at (h) only. A failure anywhere leaves the server exactly as
// it was: still answering not_deployed, with no half-built set of services.

import { join, dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import {
  assertChainIdMatchesRecord,
  assertTreasuryMatchesRecord,
  loadDeployment,
  type Chain,
  type Deployment,
} from './chain.ts';
import type { Config } from './config.ts';
import { TokenAbi } from './abi.ts';
import { buildModules, requireNames } from './modules.ts';
import { Resolver } from './resolver.ts';
import { loadPolicyDefaults } from './policy.ts';
import { Spawner } from './spawn.ts';
import { assertLedgerLifetimeIntact, assertLedgerNotRestored, gatherLifetimeFacts } from './migrate.ts';
import { assertDeploymentUnchanged } from './deployment.ts';
import { Treasury } from './treasury.ts';
import { EventTail } from './events.ts';
import { CallPolicy } from './calls.ts';
import type { ServicesHolder } from './server.ts';

export async function activate(holder: ServicesHolder, deployment: Deployment): Promise<void> {
  const { config, chain, store, keystore } = holder.boot;

  // (a) The mnemonic this service holds is the one the record was deployed from.
  assertTreasuryMatchesRecord(chain, deployment);
  // (b) The chain answering is the one the record was made on.
  await assertChainIdMatchesRecord(chain, deployment);

  // (c) Every token read from the chain. Built locally: `chain.modules` is set
  // at (h), with everything else, and not before.
  const modules = await buildModules(deployment, async (address) => {
    const [symbol, decimals] = await Promise.all([
      chain.publicClient.readContract({ address, abi: TokenAbi, functionName: 'symbol' }),
      chain.publicClient.readContract({ address, abi: TokenAbi, functionName: 'decimals' }),
    ]);
    return { symbol: symbol as string, decimals: Number(decimals) };
  });

  // (d) The store was written against this deployment, or has seen none. Each
  // fact from its own source: the record being activated, and the store.
  const liveDeployment = {
    chainId: String(deployment.chainId),
    modules: deployment.modules.map((m) => ({ kind: m.kind, key: m.key, address: m.address })),
  };
  const recordedDeployment = store.recordedDeployment();
  assertDeploymentUnchanged(recordedDeployment, liveDeployment, config.acknowledgeChainReset);
  if (recordedDeployment === null) store.recordDeployment(liveDeployment);

  // (e) The ledger was neither wiped beneath a live deployment nor restored
  // from an older copy. `getCode` reads the modules built at (c).
  const lifetime = await gatherLifetimeFacts({
    store,
    keystore,
    getCode: () =>
      chain.publicClient.getCode({
        address: modules.tokens[0]?.address ?? requireNames(modules).address,
      }),
    acknowledged: config.acknowledgeLedgerReset,
  });
  assertLedgerNotRestored(lifetime);
  assertLedgerLifetimeIntact(lifetime);
  await keystore.recordLedgerWatermark(lifetime.reservations);

  // (f) The policy defaults, against this deployment's tld and token keys.
  const defaults = config.policyDefaultsPath
    ? loadPolicyDefaults(
        config.policyDefaultsPath,
        modules.names?.tld,
        modules.tokens.map((t) => t.key),
      )
    : null;

  // (g) FRESH instances. Nothing built against an earlier activation survives
  // into this one. CallPolicy takes the modules explicitly; the rest read them
  // through `chain` per call, so they see what (h) sets.
  const resolver = new Resolver(chain, store);
  const services = {
    config,
    chain,
    resolver,
    store,
    keystore,
    spawner: new Spawner(config, chain, keystore, store, resolver, defaults),
    treasury: new Treasury(
      config,
      chain,
      keystore,
      store,
      resolver,
      defaults,
      new CallPolicy(config.policyDir, modules, (line) => console.warn(line), defaults),
    ),
  };

  // (h) THE SWAP - one step, after every check. The treasury's send lock lives
  // on Chain, outside this, so a send queued before it stays ordered after.
  chain.deployment = deployment;
  chain.modules = modules;
  holder.swap(services);

  // (i) Only now does anything tail the chain. No event tail exists before
  // activation, so nothing is emitted about a deployment that was never checked.
  const events = new EventTail(config, chain, store);
  await events.pollOnce().catch((err) => console.warn('chain-svc: initial event poll failed', err.message));
  events.start();
  holder.events = events;
}

/// Where an admin-mode service keeps the record it wrote: beside its own store,
/// on the same volume, never through /tmp.
export function adminRecordDir(config: Config): string {
  return join(dirname(config.storePath), 'deployment');
}

/// The admin-mode record, or null when this service has not deployed yet.
/// Read with the same loader and rules as the container's local.json.
export function loadAdminRecord(config: Config): Deployment | null {
  const dir = adminRecordDir(config);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  return existsSync(join(dir, 'local.json')) ? loadDeployment(dir) : null;
}

/// Whether every address in the record holds code. Measured, rather than
/// inferred from which step failed: a chain that was reset beneath its record
/// is the one boot failure the deploy route can repair, and it is the one where
/// some recorded address is empty.
export async function recordFullyOnChain(chain: Chain, deployment: Deployment): Promise<boolean> {
  for (const m of deployment.modules) {
    const code = await chain.publicClient.getCode({ address: m.address });
    if (code === undefined || code === '0x') return false;
  }
  return true;
}
