# agent-chain

A private EVM chain for agents: stand it up wherever a project needs money,
names or contracts for agents to test against, inside a private environment
with nothing reaching a public network. One `docker compose` profile brings up:

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
  It is one client of `chain-svc`'s HTTP API, not the only one.

**The API is `chain-svc`'s HTTP interface.** Anything that holds a wallet token
can use it — an agent through `wallet-mcp`, or any application or service
directly: spawn is the operator's, but balance, history, name lookup and sending
by name are the same calls for every wallet holder. The platform token is the
operator's: mint, fund, spawn, freeze, rotate, set a balance, read anything.

## How the pieces fit (the design; nodes marked *next* land with the next release)

```mermaid
flowchart LR
  subgraph deploy["Deployment (per project)"]
    M["deployments/manifest.json (next)<br/>which modules, named here"]
    D["chain-deploy<br/>one-shot forge script"]
    L["deployments/local.json<br/>what is on the chain"]
    M -.-> D --> L
  end
  subgraph chain["Chain (Anvil, private, zero gas)"]
    T1["Token A (next)<br/>ERC-20 named at deploy"]
    T2["Token B (next)<br/>optional, more instances"]
    N["NameRegistry<br/>name → address (optional)"]
    X["Custom contracts (next)<br/>optional"]
  end
  D -- deploys --> N
  D -. deploys .-> T1 & T2 & X
  subgraph svc["chain-svc (sole key holder)"]
    P["policy: caps, allow/deny,<br/>freezes, intents"]
    K["keystore: treasury +<br/>one key per wallet"]
    E["event tail → sink"]
  end
  L -- read at boot --> svc
  svc -- signed, zero-fee txs --> chain
  chain -- logs --> E
  A["Agent<br/>(any MCP host)"] -- stdio --> W["wallet-mcp<br/>no key, one wallet token"]
  W -- "HTTP, wallet token" --> svc
  U["Consumer<br/>(any app or service holding a wallet)"] -- "HTTP, wallet token" --> svc
  H["Operator<br/>(hub, harness, setup)"] -- "HTTP, platform token" --> svc
  E -- events --> H
```

A **manifest** names what a deployment has: token instances (name, symbol,
initial supply), an optional name registry (with the suffix names end in), and
further modules. `chain-svc` reads the result at boot and serves only what is
deployed: money endpoints exist when a token does, name endpoints when the
registry does, and `wallet-mcp` advertises only the tools that work. Today the
tree carries one sample ERC-20 (`VEEBux`) and the registry; the generic `Token`
named at deploy, the manifest, and module-gated endpoints are landing next, then
a generic, allowlisted contract-call operation, and a `Converter` module that
exchanges one token for another at operator-set rates.

## A payment, end to end

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent
  participant W as wallet-mcp
  participant S as chain-svc
  participant C as Chain
  participant H as Event sink
  A->>W: send to "seller", amount 5, intent_id
  W->>S: POST /sign-transfer with the wallet token
  S->>S: resolve "seller" to an address
  S->>S: policy: frozen? over cap? intent already used?
  alt refused
    S-->>W: error, one of a closed set of reasons
    W-->>A: ok false, with the reason
  else allowed
    S->>S: sign with the agent's own key, fee zero
    S->>C: transferWithIntent to, 5, intentId
    C-->>S: mined, with Transfer and IntentTransfer logs
    S-->>W: txHash
    W-->>A: ok true, with txHash
    S->>H: event transfer (from, to, amount, intent_id)
  end
```

The agent never sees an address or a key. The intent id is the idempotency key
on the service side: chain-svc refuses a second send under the same id, and the
operator can check any claimed payment in one call. The contract itself records
the id in its event and deliberately does not deduplicate, so a second emission
under one id (from anywhere) is visible as an anomaly rather than suppressed.

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

A harness takes this repo as a git submodule pinned to a tag, mounted at
`chain/`; every path on that side — the Dockerfile `COPY`, `compose -f
chain/compose.chain.yml`, the workspace members — works unchanged. Tags are the
interface. A consumer at a different directory depth than this repo is the only
build that can catch a wrong `COPY` (see `.dockerignore` for the case that
taught us), so a release is not done until a consumer has built it.

## Trust model, in one paragraph

Keys never leave `chain-svc`. Agents authenticate to it with a per-wallet token
and can act only on their own wallet, within caps the operator sets; the
operator's platform token can mint, fund, spawn, freeze and read anything, and is
held by nothing an agent can reach. The RPC is bound to loopback because it is
unauthenticated. The chain is play money by construction: private, zero-fee, and
refusing to start against anything that is not a private chain.

## Status

Pre-release. The sequence of work is: repo split (done) → modules and manifest →
generic call op → second token and converter.
