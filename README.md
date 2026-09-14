# cyberlab-chain

The cyberlab private chain: an Anvil node, the VEE Bux ERC-20 and name registry
contracts, `chain-svc` (treasury, wallet spawn, name resolution, event tail) and
`wallet-mcp` (the stdio MCP an agent uses to hold and spend by name).

`mesh-agent` consumes this repo as a git submodule mounted at `chain/`, pinned to
a tag; every path on that side — the Dockerfile `COPY`, `compose -f
chain/compose.chain.yml`, the workspace members — is unchanged by the move.

The spec is **Chain and Wallet Increment** in the `operation-powerout` vault.

## Running it

```
git submodule update --init --recursive     # Foundry vendors forge-std and OpenZeppelin
bun install
docker compose -f compose.chain.yml --profile chain up
```

`contracts/` needs Foundry v1.8.1 (`forge test`); `svc/` and `wallet-mcp/` need
only bun. `svc/src/abi.ts` is generated from the contract build and committed —
CI regenerates it and fails on a diff.
