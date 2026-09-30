// POST /admin/deploy against a real chain, beside the container path as control.
//
//   cd svc && bun run scripts/verify-admin-deploy.ts
//
// Needs two anvils, started with the chain image's flags, at RPC_A (default
// http://127.0.0.1:8545) and RPC_B (:8546), forge and cast on PATH, a built
// contracts/ tree, and ANVIL_MNEMONIC. The contracts workflow's admin-deploy
// job provides all of it. NOT a *.test.ts: `bun run test` never collects it,
// because it needs a chain the unit job does not have.
//
// It never skips. Anything it cannot check is a failure, and it exits 1.
//
// What it shows, in order:
//   1  a service with no record boots, answers deployed:false and refuses money
//   2  the route deploys the manifest (MANIFEST, default two-tokens.json) on
//      chain A; the files and their modes
//   3  the seed mint's Transfer reached the outbox (the tail started after the
//      modules were known, and read from the start)
//   4  a repeat sends zero transactions
//   5  eight concurrent /fund all succeed (every treasury send is queued)
//   6  the container deploys the same manifest on chain B; the records agree
//      field by field, the transactions agree call by call, and so do the roles;
//      then the route, over the container's deployment, sends nothing
//   7  chain A reset beneath its record: boot stays not-deployed, and the same
//      manifest redeploys to the same addresses
//   8  the store wiped beneath a keystore with wallets in it, with and without
//      intents: the route refuses with ledger_wiped_beneath_live_game and
//      writes no record

import { Database } from 'bun:sqlite';
import { spawn, spawnSync, type Subprocess } from 'bun';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { ConverterAbi, NameRegistryAbi, TokenAbi } from '../src/abi.ts';

const ROOT = resolve(import.meta.dir, '../..');
const SVC = join(ROOT, 'svc');
const RPC_A = process.env.RPC_A ?? 'http://127.0.0.1:8545';
const RPC_B = process.env.RPC_B ?? 'http://127.0.0.1:8546';
const MNEMONIC = process.env.ANVIL_MNEMONIC;
// Two-tokens by default. CI also runs deployments/cases/contract-entries.json,
// whose `contract` entries are the path the container once could not deploy.
const MANIFEST_FILE = resolve(ROOT, process.env.MANIFEST ?? 'deployments/examples/two-tokens.json');
const MANIFEST = readFileSync(MANIFEST_FILE, 'utf8');
const TOKEN = 'verify-admin-deploy-token';
const PORT = Number(process.env.SVC_PORT ?? 7391);
const URL_ = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s: string) => console.log(`\n=== ${s}`);
// BEFORE anything is started, `bail` exits. After, `die` THROWS, so the
// `finally` stops chain-svc and removes its directories: an exit from inside
// the try left the service holding the port and its store, and the next run in
// the same job talked to it (MEASURED - the CI job runs this twice).
class Abort extends Error {}
const bail = (why: string): never => {
  console.error(`FAIL ${why}`);
  process.exit(1);
};
const die = (why: string): never => {
  throw new Abort(why);
};

if (!MNEMONIC) bail('ANVIL_MNEMONIC is unset');
for (const tool of ['forge', 'cast']) {
  if (spawnSync(['sh', '-c', `command -v ${tool}`]).exitCode !== 0) bail(`${tool} is not on PATH`);
}

const rpc = async (url: string, method: string, params: unknown[] = []) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};
for (const url of [RPC_A, RPC_B]) {
  try {
    await rpc(url, 'eth_blockNumber');
  } catch (err) {
    bail(`no chain at ${url}: ${(err as Error).message}`);
  }
}

// --- the service -------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'verify-admin-deploy-'));
const dirs = { store: join(work, 'store'), keystore: join(work, 'keystore'), policies: join(work, 'policies') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const recordDir = join(dirs.store, 'deployment');
const storePath = join(dirs.store, 'chain-svc.sqlite');
let svc: Subprocess | null = null;
let svcLog = '';

async function startSvc(rpcUrl = RPC_A, d: typeof dirs = dirs): Promise<void> {
  svcLog = '';
  svc = spawn(['bun', 'run', 'src/index.ts'], {
    cwd: SVC,
    env: {
      ...process.env,
      PORT: String(PORT),
      RPC_URL: rpcUrl,
      DEPLOY_MODE: 'admin',
      CHAIN_SVC_TOKEN: TOKEN,
      KEYSTORE_SECRET: 'verify-admin-deploy-secret',
      ANVIL_MNEMONIC: MNEMONIC,
      KEYSTORE_DIR: d.keystore,
      POLICY_DIR: d.policies,
      STORE_PATH: join(d.store, 'chain-svc.sqlite'),
      POLICY_DEFAULTS_FILE: join(SVC, 'policy-defaults.example.json'),
      HUB_CORE_URL: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  for (const stream of [svc.stdout, svc.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      for await (const chunk of stream) svcLog += new TextDecoder().decode(chunk);
    })();
  }
  for (let i = 0; i < 100; i++) {
    if (svc.exitCode !== null) die(`chain-svc exited ${svc.exitCode}:\n${svcLog}`);
    try {
      if ((await fetch(`${URL_}/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(100);
  }
  die(`chain-svc did not answer /health:\n${svcLog}`);
}

async function stopSvc(): Promise<void> {
  if (!svc) return;
  svc.kill();
  await svc.exited;
  svc = null;
}

async function api(method: string, path: string, body?: unknown, raw?: string) {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

interface DeployReply {
  deployment: { modules: { kind: string; key?: string; address: Address; codehash: Hex }[] };
  modules: { kind: string; key?: string; address: Address; status: string }[];
  txs: Hex[];
}
const deploy = () => api('POST', '/admin/deploy', undefined, MANIFEST);
const cursors = () => {
  const db = new Database(storePath, { readonly: true });
  const rows = db.query(`SELECT name, value FROM cursors`).all();
  db.close();
  return rows;
};
const notDeployed = async () => JSON.stringify(await (await fetch(`${URL_}/health`)).json()) === '{"ok":true,"deployed":false}';

// --- the roles a deployment has, read from a chain ---------------------------

async function roleTable(url: string, record: DeployReply['deployment'], treasury: Address): Promise<string[]> {
  const client = createPublicClient({ transport: http(url) });
  // Every holder that could matter: the treasury, zero, and every module - a
  // contract entry's admin can be another module (`@play`).
  const who: [string, Address][] = [['treasury', treasury], ['zero', '0x0000000000000000000000000000000000000000']];
  for (const m of record.modules) who.push([`${m.kind}${m.key ? `:${m.key}` : ''}`, m.address]);
  const rows: string[] = [];
  for (const m of record.modules) {
    const contract = (m as { contract?: string }).contract;
    const [abi, names]: [unknown, string[]] =
      m.kind === 'token'
        ? [TokenAbi, ['DEFAULT_ADMIN_ROLE', 'MINTER_ROLE', 'BURNER_ROLE', 'FREEZER_ROLE']]
        : m.kind === 'names'
          ? [NameRegistryAbi, ['DEFAULT_ADMIN_ROLE', 'REGISTRAR_ROLE']]
          : m.kind === 'converter' || contract === 'Converter'
            ? [ConverterAbi, ['DEFAULT_ADMIN_ROLE', 'RATE_ADMIN_ROLE']]
            : die(`no role table for ${m.kind} ${contract}; add one rather than skip it`);
    for (const name of names) {
      const role = (await client.readContract({ address: m.address, abi: abi as never, functionName: name as never })) as Hex;
      for (const [label, addr] of who) {
        const has = await client.readContract({ address: m.address, abi: abi as never, functionName: 'hasRole' as never, args: [role, addr] as never });
        rows.push(`${m.kind}${m.key ? `:${m.key}` : ''} ${name} ${label}=${has}`);
      }
    }
  }
  return rows;
}

async function calls(url: string, hashes: Hex[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of hashes) {
    const tx = (await rpc(url, 'eth_getTransactionByHash', [h])) as { to: string; input: string };
    out.push(`${tx.to.toLowerCase()} ${tx.input}`);
  }
  return out;
}

try {
  const treasury = (spawnSync(['cast', 'wallet', 'address', '--mnemonic', MNEMONIC as string]).stdout.toString().trim()) as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(treasury)) die(`could not derive the treasury address (got "${treasury}")`);

  step('1  boot with no record');
  await startSvc();
  check('/health says not deployed', JSON.stringify((await (await fetch(`${URL_}/health`)).json())) === '{"ok":true,"deployed":false}');
  const supply = await api('GET', '/supply');
  check('a money route answers 503 not_deployed', supply.status === 503 && supply.body.error === 'not_deployed', `${supply.status} ${supply.body.error}`);
  check('the record directory exists before any deploy', existsSync(recordDir) && (statSync(recordDir).mode & 0o777) === 0o755);
  // NOTHING TAILS THE CHAIN YET. Every poll writes the observed head, so a
  // store with no cursor after two poll intervals and a new block is a store
  // nothing has polled into. Step 3 is the consequence this prevents - a
  // tail that read past the seed mint before it knew the token - but it only
  // fails when a poll happens to land between the mint and activation.
  await rpc(RPC_A, 'evm_mine');
  await Bun.sleep(2500);
  check('no event tail has polled', cursors().length === 0, JSON.stringify(cursors()));

  step(`2  the route deploys ${MANIFEST_FILE.slice(ROOT.length + 1)} on chain A`);
  const first = await deploy();
  check('POST /admin/deploy answers 200', first.status === 200, JSON.stringify(first.body).slice(0, 400));
  const reply = first.body as unknown as DeployReply;
  check('every module was deployed', reply.modules?.every((m) => m.status === 'deployed') === true);
  check('transactions were sent', (reply.txs?.length ?? 0) > 0, `${reply.txs?.length}`);
  const health = (await (await fetch(`${URL_}/health`)).json()) as { modules?: unknown };
  check('/health now lists the modules', health.modules !== undefined, JSON.stringify(health));
  const recordPath = join(recordDir, 'local.json');
  const manifestPath = join(recordDir, 'manifest.json');
  check('local.json is 0644', existsSync(recordPath) && (statSync(recordPath).mode & 0o777) === 0o644);
  check('manifest.json is 0600', existsSync(manifestPath) && (statSync(manifestPath).mode & 0o777) === 0o600);
  check('manifest.json is the manifest as sent', existsSync(manifestPath) && readFileSync(manifestPath, 'utf8') === MANIFEST);
  check('no temp file is left', readdirSync(recordDir).every((f) => !f.endsWith('.tmp')), readdirSync(recordDir).join(','));
  const routeRecord = JSON.parse(readFileSync(recordPath, 'utf8'));
  check('the reply carries the record written', JSON.stringify(reply.deployment) === JSON.stringify(routeRecord));

  step('3  the seed mint is in the outbox');
  let seeded = false;
  for (let i = 0; i < 50 && !seeded; i++) {
    const db = new Database(storePath, { readonly: true });
    const rows = db.query(`SELECT payload FROM outbox WHERE kind = 'chain.transfer'`).all() as { payload: string }[];
    db.close();
    seeded = rows.some((r) => {
      const p = JSON.parse(r.payload);
      return p.from === '0x0000000000000000000000000000000000000000' && p.to.toLowerCase() === treasury.toLowerCase() && p.token === 'PLAY';
    });
    if (!seeded) await Bun.sleep(200);
  }
  check('a Transfer from zero to the treasury, in PLAY, was enqueued', seeded);

  step('4  a repeat sends nothing');
  const again = await deploy();
  const againReply = again.body as unknown as DeployReply;
  check('POST /admin/deploy again answers 200', again.status === 200, JSON.stringify(again.body).slice(0, 300));
  check('zero transactions', Array.isArray(againReply.txs) && againReply.txs.length === 0, JSON.stringify(againReply.txs));
  check('every module present', againReply.modules?.every((m) => m.status === 'present') === true);

  step('5  eight concurrent /fund');
  const spawned = await api('POST', '/wallets', { agentId: 'orch:vendor', kind: 'agent', alias: 'vendor.play' });
  check('a wallet to fund', spawned.status === 200, JSON.stringify(spawned.body).slice(0, 300));
  const funds = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/fund', { to: 'vendor.play', amount: '1' })));
  const funded = funds.filter((f) => f.status === 200).length;
  check('all eight succeeded', funded === 8, `${funded}/8 ${funds.filter((f) => f.status !== 200).map((f) => JSON.stringify(f.body)).join(' ')}`);

  step('6  the container deploys the same manifest on chain B');
  const control = join(ROOT, 'deployments', 'test-control');
  rmSync(control, { recursive: true, force: true });
  mkdirSync(control, { recursive: true });
  cpSync(MANIFEST_FILE, join(control, 'manifest.json'));
  const once = spawnSync(['sh', join(ROOT, 'docker/deploy-once.sh')], {
    cwd: ROOT,
    env: { ...process.env, CONTRACTS_DIR: join(ROOT, 'contracts'), DEPLOYMENTS_DIR: control, RPC_URL: RPC_B, ANVIL_MNEMONIC: MNEMONIC },
  });
  if (once.exitCode !== 0) die(`deploy-once.sh exited ${once.exitCode}:\n${once.stdout}\n${once.stderr}`);
  const containerRecord = JSON.parse(readFileSync(join(control, 'local.json'), 'utf8'));
  check('the records are identical, byte for byte', readFileSync(join(control, 'local.json'), 'utf8').trim() === readFileSync(recordPath, 'utf8').trim());
  for (const field of ['schema', 'chainId', 'treasury'] as const) {
    check(`record ${field}`, routeRecord[field] === containerRecord[field], `${routeRecord[field]} vs ${containerRecord[field]}`);
  }
  check('same number of modules', routeRecord.modules.length === containerRecord.modules.length);
  routeRecord.modules.forEach((m: Record<string, unknown>, i: number) => {
    const c = containerRecord.modules[i] ?? {};
    for (const k of new Set([...Object.keys(m), ...Object.keys(c)])) {
      check(`module ${i} ${k}`, m[k] === c[k], `${m[k]} vs ${c[k]}`);
    }
  });
  const broadcast = JSON.parse(readFileSync(join(ROOT, 'contracts/broadcast/Deploy.s.sol/31337/run-latest.json'), 'utf8')) as {
    transactions: { transaction: { to?: string; input: string } }[];
  };
  const forgeCalls = broadcast.transactions.map((t) => `${(t.transaction.to ?? '').toLowerCase()} ${t.transaction.input}`);
  const routeCalls = await calls(RPC_A, reply.txs);
  check(`the same ${forgeCalls.length} transactions, in order, calldata and all`, JSON.stringify(routeCalls) === JSON.stringify(forgeCalls),
    routeCalls.length !== forgeCalls.length ? `${routeCalls.length} vs ${forgeCalls.length}` : `first difference at ${routeCalls.findIndex((c, i) => c !== forgeCalls[i])}`);
  const rolesA = await roleTable(RPC_A, routeRecord, treasury);
  const rolesB = await roleTable(RPC_B, containerRecord, treasury);
  check(`the same ${rolesA.length} role facts`, rolesA.length > 0 && JSON.stringify(rolesA) === JSON.stringify(rolesB),
    rolesA.filter((r, i) => r !== rolesB[i]).join('; '));

  step('6b the route over the container\'s deployment on chain B');
  // Container to admin: the same manifest finds every module there, and sends
  // nothing - no mint on a token with supply, no pair or role already set.
  await stopSvc();
  const dirsB = { store: join(work, 'b-store'), keystore: join(work, 'b-keystore'), policies: join(work, 'b-policies') };
  for (const d of Object.values(dirsB)) mkdirSync(d, { recursive: true });
  await startSvc(RPC_B, dirsB);
  const over = await deploy();
  const overReply = over.body as unknown as DeployReply;
  check('POST /admin/deploy answers 200', over.status === 200, JSON.stringify(over.body).slice(0, 300));
  check('zero transactions', Array.isArray(overReply.txs) && overReply.txs.length === 0, JSON.stringify(overReply.txs));
  check('every module present', overReply.modules?.every((m) => m.status === 'present') === true);
  check('the record it wrote is the container\'s', readFileSync(join(dirsB.store, 'deployment/local.json'), 'utf8').trim() === readFileSync(join(control, 'local.json'), 'utf8').trim());
  await stopSvc();
  await startSvc();

  step('7  chain A reset beneath its record');
  await stopSvc();
  await rpc(RPC_A, 'anvil_reset', []);
  const empty = (await rpc(RPC_A, 'eth_getCode', [routeRecord.modules[0].address, 'latest'])) as string;
  check('the reset removed the contracts', empty === '0x', empty.slice(0, 20));
  await startSvc();
  check('boot stays up, not deployed', await notDeployed(), svcLog.split('\n').slice(-5).join(' | '));
  const redeploy = await deploy();
  const redeployReply = redeploy.body as unknown as DeployReply;
  check('the same manifest redeploys', redeploy.status === 200, JSON.stringify(redeploy.body).slice(0, 400));
  check('to the same addresses', JSON.stringify(redeployReply.deployment?.modules?.map((m) => m.address)) === JSON.stringify(routeRecord.modules.map((m: { address: string }) => m.address)));
  check('every module deployed again', redeployReply.modules?.every((m) => m.status === 'deployed') === true);

  // TWO LEDGER CONTROLS, and each scenario reaches a different one first. With
  // intents reserved (8a), the keystore's watermark is above a wiped store's
  // count, and assertLedgerNotRestored refuses. With a wallet and no intent
  // ever reserved (8b), only assertLedgerLifetimeIntact can see it - so
  // dropping either control fails a check here.
  const wipeStore = () => {
    rmSync(dirs.store, { recursive: true, force: true });
    mkdirSync(dirs.store);
  };
  const refusesWiped = async (label: string) => {
    const wiped = await deploy();
    check(`${label}: the route refuses with ledger_wiped_beneath_live_game`,
      wiped.status === 409 && String(wiped.body.detail).startsWith('ledger_wiped_beneath_live_game:'),
      `${wiped.status} ${JSON.stringify(wiped.body).slice(0, 300)}`);
    check(`${label}: and writes no record`, !existsSync(join(recordDir, 'local.json')));
    check(`${label}: and stays not deployed`, await notDeployed());
  };

  step('8a the store wiped beneath a keystore that has reserved intents');
  await stopSvc();
  check('the keystore holds a wallet', readdirSync(dirs.keystore).length > 0);
  wipeStore();
  await startSvc();
  await refusesWiped('8a');

  step('8b the store wiped beneath a keystore with a wallet and no intents');
  await stopSvc();
  rmSync(dirs.keystore, { recursive: true, force: true });
  mkdirSync(dirs.keystore);
  wipeStore();
  await startSvc();
  const fresh = await deploy();
  check('a fresh store and keystore deploy over the contracts already there', fresh.status === 200 && (fresh.body as unknown as DeployReply).txs.length === 0,
    `${fresh.status} ${JSON.stringify(fresh.body).slice(0, 200)}`);
  const solo = await api('POST', '/wallets', { agentId: 'orch:solo', kind: 'agent' });
  check('a wallet, with no funding', solo.status === 200, JSON.stringify(solo.body).slice(0, 200));
  const db = new Database(storePath, { readonly: true });
  const intents = (db.query(`SELECT COUNT(*) AS n FROM intents`).get() as { n: number }).n;
  db.close();
  check('and no intent reserved', intents === 0, `${intents}`);
  await stopSvc();
  wipeStore();
  await startSvc();
  await refusesWiped('8b');
} catch (err) {
  if (!(err instanceof Abort)) throw err;
  console.error(`FAIL ${err.message}`);
  failures++;
} finally {
  await stopSvc();
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nPASS: verify-admin-deploy' : `\nFAIL: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
