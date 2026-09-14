#!/usr/bin/env bash
# Runnable evidence for spec S8 criterion 4: brings up the chain and chain-svc,
# spawns two wallets, then drives wallet-mcp OVER STDIO with a real MCP client
# (scripts/mcp-probe.ts) - the same transport the harness uses.
# Needs Docker and Foundry.
set -euo pipefail

IMAGE=${IMAGE:-agent-chain-anvil:dev}; NAME=${NAME:-agent-chain-anvil-wallet}; VOLUME=${VOLUME:-agent-chain-wallet-state}
RPC=${RPC:-http://127.0.0.1:8545}; PORT=${PORT:-7005}; TOKEN=${CHAIN_SVC_TOKEN:-wallet-verify-token}
MNEMONIC="test test test test test test test test test test test junk"
HERE="$(cd "$(dirname "$0")" && pwd)"; MCP="$HERE/.."; SVC="$MCP/../svc"
CONTRACTS="$MCP/../contracts"; DEPLOYMENTS="$MCP/../deployments"
WORK=$(mktemp -d); SVC_PID=""

predown() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOLUME" >/dev/null 2>&1 || true; }
cleanup() { [ -n "$SVC_PID" ] && kill "$SVC_PID" 2>/dev/null || true; predown; rm -rf "$WORK"; }
trap cleanup EXIT; predown

printf '\n=== chain up + deploy + chain-svc\n'
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -e ANVIL_MNEMONIC="$MNEMONIC" -v "$VOLUME:/state" -p 127.0.0.1:8545:8545 "$IMAGE" >/dev/null
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break; sleep 1; done
rm -f "$DEPLOYMENTS/local.json"
# The manifest this script's deployment declares. chain-deploy requires one and
# has no built-in default, so a script that deploys must say what it deploys --
# and the TLD here is the suffix every name below is registered under. Without
# this the deploy refuses and every check afterwards is testing nothing.
cat > "$DEPLOYMENTS/manifest.json" <<'MANIFEST_JSON'
{
  "schema": 1,
  "modules": [
    { "kind": "token", "key": "play", "name": "Play Token", "symbol": "PLAY", "initialSupply": "1000000" },
    { "kind": "names", "tld": "play" }
  ]
}
MANIFEST_JSON
KEY=$(docker logs "$NAME" 2>&1 | awk '/^Private Keys/{f=1;next} f&&/^\(0\)/{print $2;exit}')
( cd "$CONTRACTS" && DEPLOYER_PRIVATE_KEY="$KEY" DEPLOYMENTS_DIR="$DEPLOYMENTS" \
    forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast ) >/dev/null 2>&1
( cd "$SVC" && RPC_URL="$RPC" CHAIN_SVC_TOKEN="$TOKEN" KEYSTORE_SECRET=s ANVIL_MNEMONIC="$MNEMONIC" \
    DEPLOYMENTS_DIR="$DEPLOYMENTS" KEYSTORE_DIR="$WORK/k" POLICY_DIR="$WORK/policies" \
    STORE_PATH="$WORK/s/db.sqlite" PORT="$PORT" bun run src/index.ts ) >"$WORK/svc.log" 2>&1 &
SVC_PID=$!
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
U="http://127.0.0.1:$PORT"; A=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

# Funded above max_per_stage on purpose, so the wallet runs out of CAP before it
# runs out of MONEY - otherwise the stage-cap check would really be measuring an
# overdraft, which is a mistake this suite has already made once.
SB=$(curl -fsS "${A[@]}" -X POST "$U/wallets" -d '{"agentId":"orch:vendor","fundVee":1000,"kind":"agent","alias":"vendor.play"}')
WALLET_TOKEN=$(echo "$SB" | jget "['walletToken']")
curl -fsS "${A[@]}" -X POST "$U/wallets" -d '{"agentId":"alpha:client","fundVee":10,"kind":"agent","alias":"alpha.play"}' >/dev/null
# A lookalike owned by someone else, for the resolve check.
curl -fsS "${A[@]}" -X POST "$U/wallets" -d '{"agentId":"orch:scammer","fundVee":0,"kind":"agent"}' >/dev/null
curl -fsS "${A[@]}" -X POST "$U/aliases" -d '{"agentId":"orch:scammer","alias":"aIpha.play"}' >/dev/null
echo "  wallets spawned; policy file: $(ls "$WORK/policies")"

cd "$MCP"
WALLET_AGENT_ID=orch:vendor \
  CHAIN_SVC_URL="$U" \
  WALLET_TOKEN="$WALLET_TOKEN" \
  POLICY_FILE="$WORK/policies/orch%3Avendor.json" \
  WALLET_STATE_FILE="$WORK/wallet-state.json" \
  bun run scripts/mcp-probe.ts
