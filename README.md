# private-chain

A private EVM chain for private environments: stand it up wherever a project
needs money, names or contracts to test against, with nothing reaching a public
network. One `docker compose` profile brings up:

- **`chain`** — a single-node [Anvil](https://github.com/foundry-rs/foundry) node
  (chain id 31337), loopback only, zero gas, state persisted to a volume.
- **`chain-deploy`** — a one-shot Foundry script that deploys the contracts and
  writes their addresses to `deployments/local.json`.
- **`chain-svc`** — the only process that holds keys. It custodies one key per
  wallet plus the treasury, applies policy (per-wallet caps, allow/deny lists,
  freezes, idempotent intents), signs and sends, and publishes every transfer,
  name change and anomaly to an event sink over HTTP. Everything else talks to
  the chain through it.
- **`wallet-mcp`** — a small stdio [MCP](https://modelcontextprotocol.io) server
  an agent runs to hold and spend by *name*, never by address. It keeps no key
  and maps every refusal onto a short, closed set of reasons an agent may see.

Today the contracts are an ERC-20 play currency (`VEEBux`, symbol `VEE`) and a
name registry. The chain is being made modular: a per-deployment manifest will
choose which contracts to deploy — tokens as instances of one generic `Token`,
an optional name registry, a `Converter` between tokens, and custom contracts —
with `chain-svc` gating its endpoints on what is actually deployed and a generic,
allowlisted contract-call operation on top. Until that lands, every deployment
gets the two contracts above.

## Layout

```
contracts/          Foundry project: src/, script/Deploy.s.sol, test/, mutation/
deployments/        local.json for THIS deployment (gitignored)
docker/             the Anvil image and verification scripts
svc/                chain-svc (bun, HTTP on 127.0.0.1:7000)
wallet-mcp/         the MCP server (bun, stdio)
compose.chain.yml   the `chain` profile
```

## Running it

```
git submodule update --init --recursive   # Foundry vendors forge-std and OpenZeppelin
bun install
docker compose -f compose.chain.yml --profile chain up
```

Compose reads three secrets from a `.env` in this directory (or from the
environment): `ANVIL_MNEMONIC` (a BIP-39 phrase), `CHAIN_SVC_TOKEN` (the
operator's platform token) and `KEYSTORE_SECRET` (encrypts wallet keys at rest).
Generate them; never commit them.

`contracts/` needs Foundry v1.8.1 (`forge test`); `svc/` and `wallet-mcp/` need
only bun. `svc/src/abi.ts` is generated from the contract build and committed —
CI regenerates it and fails on a diff, so a contract change that is not reflected
in the service cannot merge.

## Consuming it

Another repository takes this one as a git submodule pinned to a tag (the
mesh-agent arena mounts it at `chain/`, and every path on that side — the
Dockerfile `COPY`, `compose -f chain/compose.chain.yml`, the workspace members
— works unchanged). Tags are the interface: `v0.1.1` is the first tag a
consumer at a different directory depth can build (see `.dockerignore` for why).

## Trust model, in one paragraph

Keys never leave `chain-svc`. Agents authenticate to it with a per-wallet token
and can act only on their own wallet, within caps the operator sets; the
operator's platform token can mint, fund, spawn, freeze and read anything, and is
held by nothing an agent can reach. The RPC is bound to loopback because it is
unauthenticated. The chain is play money by construction: private, zero-fee, and
refusing to start against anything that is not a private chain.

## Status

Pre-release. Design notes and the decision record live in the maintainers'
vault; the sequence of increments is: repo split (done) → modules and manifest →
generic call op → second currency and converter.
