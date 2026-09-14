#!/usr/bin/env bash
# Runnable evidence for the read endpoints against a REAL chain: starts Anvil,
# deploys, runs chain-svc, and checks /supply, /resolve, /balance and the auth
# refusals. Needs Docker and Foundry, so it cannot run in the repo's CI - run it
# by hand and paste the output into the PR:
#   ./svc/scripts/verify-reads.sh
set -euo pipefail

IMAGE=${IMAGE:-agent-chain-anvil:dev}
NAME=${NAME:-agent-chain-anvil-svc-verify}
VOLUME=${VOLUME:-agent-chain-state-svc-verify}
RPC=${RPC:-http://127.0.0.1:8545}
PORT=${PORT:-7000}
TOKEN=${CHAIN_SVC_TOKEN:-verify-token}
MNEMONIC="test test test test test test test test test test test junk"

HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$HERE/.."
CONTRACTS="$SVC/../contracts"
WORK=$(mktemp -d)
SVC_PID=""

step() { printf '\n=== %s\n' "$1"; }
cleanup() {
  [ -n "$SVC_PID" ] && kill "$SVC_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
cleanup >/dev/null 2>&1 || true

step "chain up"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -e ANVIL_MNEMONIC="$MNEMONIC" \
  -v "$VOLUME:/state" -p 127.0.0.1:8545:8545 "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
  sleep 1
done
echo "health: $(docker inspect -f '{{.State.Health.Status}}' "$NAME")"

step "deploy"
# The real deployments dir, not a temp one: foundry's fs_permissions
# deliberately scopes writes to ../deployments, so a temp path is refused.
# local.json is gitignored, so this leaves no tracked artefact behind.
DEPLOYMENTS="$CONTRACTS/../deployments"
mkdir -p "$DEPLOYMENTS"
rm -f "$DEPLOYMENTS/local.json"
KEY=$(docker logs "$NAME" 2>&1 | awk '/^Private Keys/{f=1;next} f&&/^\(0\)/{print $2;exit}')
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
( cd "$CONTRACTS" && DEPLOYER_PRIVATE_KEY="$KEY" DEPLOYMENTS_DIR="$DEPLOYMENTS" \
    forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast ) \
  2>&1 | grep -E "^  Deploy: |ONCHAIN EXECUTION" | head -5

step "chain-svc up"
( cd "$SVC" && RPC_URL="$RPC" CHAIN_SVC_TOKEN="$TOKEN" KEYSTORE_SECRET=verify-secret \
    ANVIL_MNEMONIC="$MNEMONIC" DEPLOYMENTS_DIR="$DEPLOYMENTS" \
    KEYSTORE_DIR="$WORK/keystore" POLICY_DIR="$WORK/policies" \
    STORE_PATH="$WORK/store/chain-svc.sqlite" PORT="$PORT" \
    bun run src/index.ts ) &
SVC_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
echo "health: $(curl -fsS "http://127.0.0.1:$PORT/health")"

A=(-H "Authorization: Bearer $TOKEN")
get() { curl -fsS "${A[@]}" "http://127.0.0.1:$PORT$1"; }

step "criterion 2, /supply half"
SUPPLY=$(get /supply); echo "GET /supply -> $SUPPLY"

step "reads by name"
echo "GET /resolve/treasury.play -> $(get /resolve/treasury.play)"
echo "GET /balance/treasury.play -> $(get /balance/treasury.play)"
TREASURY=$(get /resolve/treasury.play | sed 's/.*"address":"\([^"]*\)".*/\1/')
echo "GET /reverse/$TREASURY -> $(get "/reverse/$TREASURY")"

step "refusals"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }
echo "no token           -> $(code "http://127.0.0.1:$PORT/supply")"
echo "wrong token        -> $(code -H "Authorization: Bearer wrong" "http://127.0.0.1:$PORT/supply")"
echo "bare local id      -> $(code "${A[@]}" "http://127.0.0.1:$PORT/resolve/client") $(body "${A[@]}" "http://127.0.0.1:$PORT/resolve/client")"
echo "two-colon origin   -> $(code "${A[@]}" "http://127.0.0.1:$PORT/resolve/orch%3Apod1%3Aalice") $(body "${A[@]}" "http://127.0.0.1:$PORT/resolve/orch%3Apod1%3Aalice")"
echo "unknown alias      -> $(code "${A[@]}" "http://127.0.0.1:$PORT/resolve/nobody.play") $(body "${A[@]}" "http://127.0.0.1:$PORT/resolve/nobody.play")"

step "verdict"
case "$SUPPLY" in
  *'"total":"1000000"'*) echo "PASS: /supply reports the seeded supply" ;;
  *) echo "FAIL: unexpected /supply: $SUPPLY"; exit 1 ;;
esac
