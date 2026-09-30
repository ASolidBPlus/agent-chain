// POST /admin/deploy: this service deploying its own chain's modules.
//
// THE ORDER IS THE CONTROL. Nothing is sent until the whole manifest has been
// validated and every pre-flight has passed; no record is written until the
// deployment on chain has passed every post-deploy check AND every activation
// check; and the services go live only after the record is on disk. A failure
// at any step leaves the service as it was, and a retry of the same manifest
// re-plans from what is actually on chain.
//
//   1 validate      the manifest grammar (manifest.ts)
//   2 pre-flight    addresses, the record's own rules, policy defaults, the
//                   store's identity, and any manifest already deployed here
//   3 plan          what is at each address now
//   4 send          what is missing, and nothing else
//   5 assert        roles, wiring and seed, read back from the chain
//   6 prepare       activation steps (a)-(g), against the record about to exist
//   7 write         the manifest, then the record it made
//   8 commit        activation steps (h)-(i): the services go live

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, chmodSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { HttpError } from './errors.ts';
import { requirePlatform, type Principal } from './auth.ts';
import { validateDeployment, type Deployment } from './chain.ts';
import { loadPolicyDefaults } from './policy.ts';
import { assertDeploymentUnchanged, ChainSwapError } from './deployment.ts';
import { JsonNumber, KIND_NAMES, KIND_TOKEN, parseManifestText, readManifest } from './manifest.ts';
import {
  assertDeployment,
  deriveModules,
  recordFor,
  sendDeployment,
  statusOf,
  type ModuleStatus,
} from './deploy.ts';
import { adminRecordDir, commitActivation, prepareActivation } from './activate.ts';
import type { ServicesHolder } from './server.ts';

export interface DeployReply {
  deployment: Deployment;
  modules: { kind: string; key?: string; contract: string; address: Address; status: ModuleStatus }[];
  txs: Hex[];
}

/// ONE DEPLOY AT A TIME. A second call waits for the first and then re-plans
/// from what is on chain - which, after a success, is zero transactions. The
/// individual sends are already ordered by the treasury's queue; this orders
/// whole deploys, so two cannot interleave their plans.
let tail: Promise<unknown> = Promise.resolve();

export function adminDeploy(holder: ServicesHolder, principal: Principal, rawBody: string): Promise<DeployReply> {
  requirePlatform(principal, 'POST /admin/deploy');
  const run = tail.then(() => deployOnce(holder, rawBody));
  tail = run.catch(() => undefined);
  return run;
}

async function deployOnce(holder: ServicesHolder, rawBody: string): Promise<DeployReply> {
  const { config, chain, store } = holder.boot;
  if (config.deployMode !== 'admin') {
    // Sends nothing: a stack deploys by one path, and this one's is the container.
    throw new HttpError('deployment_conflict', 'this stack deploys with the boot container (DEPLOY_MODE=container)');
  }
  const treasury = chain.treasury as Address;
  const dir = adminRecordDir(config);
  const recordPath = join(dir, 'local.json');
  const manifestPath = join(dir, 'manifest.json');

  // 1 validate
  const doc = parseManifestText(rawBody);
  const manifest = readManifest(doc);

  // 2 pre-flight: every check that needs no transaction.
  const planned = deriveModules(manifest, treasury);
  const chainId = await chain.publicClient.getChainId();
  const record = recordFor(planned, treasury, chainId);
  let deployment: Deployment;
  try {
    // (ii) The record this would write, held to the rules any record is held to.
    deployment = validateDeployment(record as unknown as Record<string, unknown>, 'the deployment this manifest describes');
  } catch (err) {
    throw new HttpError('invalid_request', err instanceof Error ? err.message : String(err));
  }
  if (config.policyDefaultsPath) {
    // (iii) The policy defaults against this manifest's tld and token keys -
    // the check activation would otherwise make after the contracts exist.
    try {
      loadPolicyDefaults(
        config.policyDefaultsPath,
        manifest.modules.find((m) => m.kind === KIND_NAMES)?.tld,
        manifest.modules.filter((m) => m.kind === KIND_TOKEN).map((m) => m.key as string),
      );
    } catch (err) {
      throw new HttpError('invalid_request', `policy defaults: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // (iv) A store that was written against another deployment.
  const recorded = store.recordedDeployment();
  if (recorded !== null) {
    try {
      assertDeploymentUnchanged(
        recorded,
        { chainId: String(chainId), modules: deployment.modules.map((m) => ({ kind: m.kind, key: m.key, address: m.address })) },
        false,
      );
    } catch (err) {
      if (err instanceof ChainSwapError) throw new HttpError('deployment_conflict', err.message);
      throw err;
    }
  }
  // (v) THE SAME MANIFEST, or none. Compared as documents - key order aside,
  // numbers by their text - because a record cannot see a changed
  // initialSupply or rate, and deploying on top would say nothing about either.
  //
  // NOT `deep-equal after JSON.parse`: JSON.parse reads 9007199254740993 and
  // 9007199254740992 as one number, so a supply changed by one unit would pass
  // as the same manifest (MEASURED). Numbers are compared by their text, which
  // errs the other way - 1000 and 1e3 conflict - and a false conflict is a 409
  // an operator can read, where a false match is a deployment nobody asked for.
  const recordExists = existsSync(recordPath);
  if (recordExists) {
    // The manifest is written before the record, so a record without one was
    // not left by this route; nothing says which manifest made it.
    if (!existsSync(manifestPath)) {
      throw new HttpError('deployment_conflict', `${recordPath} exists with no manifest.json beside it; nothing says what it was deployed from`);
    }
    if (canonical(parseManifestText(readFileSync(manifestPath, 'utf8'))) !== canonical(doc)) {
      throw new HttpError('deployment_conflict', 'this chain is already deployed from another manifest');
    }
  }

  // 3 plan, 4 send, 5 assert
  const status = await statusOf(chain, planned);
  const txs = await sendDeployment(chain, manifest, planned, status, treasury, recordExists);
  await assertDeployment(chain, manifest, planned, treasury);

  const reply: DeployReply = {
    deployment: record,
    modules: planned.map((p, i) => ({
      kind: p.spec.kind,
      ...(p.spec.key !== undefined ? { key: p.spec.key } : {}),
      contract: p.contract,
      address: p.address,
      status: status[i],
    })),
    txs,
  };

  // ALREADY LIVE: a repeat of the deploy that made it. The re-plan above sent
  // nothing and re-checked everything; rebuilding the services and the event
  // tail would change nothing but interrupt them.
  if (holder.current !== null) return reply;

  // 6 prepare, 7 write, 8 commit
  const prepared = await prepareActivation(holder, deployment);
  // The manifest first: a crash between the two leaves no record, and the
  // retry compares against nothing and re-plans from the chain.
  writeDurably(manifestPath, rawBody, 0o600);
  writeDurably(recordPath, `${JSON.stringify(record, null, 2)}\n`, 0o644);
  await commitActivation(holder, prepared);
  return reply;
}

/// Written as a temp file IN THE SAME DIRECTORY, fsynced, then renamed over the
/// target: a rename within one filesystem is atomic, so a crash leaves the old
/// file or the new one and never half of either. Never through /tmp, which is a
/// separate filesystem in the container, so a rename from it is not a rename.
function writeDurably(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, mode);
}

/// A document as a string that two equal documents share: keys sorted, numbers
/// by the text forge would read them as.
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x instanceof JsonNumber) return { $number: x.source };
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]]));
    }
    return x;
  });
}
