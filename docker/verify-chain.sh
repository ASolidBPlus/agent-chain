#!/usr/bin/env bash
# Runnable evidence for spec S8 criterion 2, Anvil half: a cold start deploys,
# a second run is idempotent, and balances survive `docker restart`.
#
# Not a unit test - it needs a Docker daemon, so it cannot run in the repo's CI.
# Run it by hand and paste the output into the PR:  ./docker/verify-chain.sh
set -euo pipefail

IMAGE=${IMAGE:-agent-chain-anvil:dev}
NAME=${NAME:-agent-chain-anvil-verify}
VOLUME=${VOLUME:-agent-chain-state-verify}
RPC=${RPC:-http://127.0.0.1:8545}
# The canonical, publicly-published Foundry/Hardhat test phrase, for an ephemeral
# container destroyed on exit. Deliberately a WELL-KNOWN value so nobody mistakes
# it for a secret: the real ANVIL_MNEMONIC lives in the hub .env (spec S10) and
# is generated with `cast wallet new-mnemonic`.
MNEMONIC=${ANVIL_MNEMONIC:-"test test test test test test test test test test test junk"}
CONTRACTS_DIR="$(cd "$(dirname "$0")/../contracts" && pwd)"

step() { printf '\n=== %s\n' "$1"; }
cleanup() { docker rm -f "$NAME" "$NAME-noq" >/dev/null 2>&1 || true; docker volume rm "$VOLUME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
rm -f "$CONTRACTS_DIR/../deployments/local.json"

step "the entrypoint refuses to start without a mnemonic"
if docker run --rm "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: started with ANVIL_MNEMONIC unset"; exit 1
fi
docker run --rm "$IMAGE" 2>&1 | head -1 || true

step "the entrypoint refuses a truncated phrase (the .env quoting mistake)"
if docker run --rm -e ANVIL_MNEMONIC="test test test" "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: started with a 3-word ANVIL_MNEMONIC"; exit 1
fi
docker run --rm -e ANVIL_MNEMONIC="test test test" "$IMAGE" 2>&1 | head -1 || true

step "cold start"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -e ANVIL_MNEMONIC="$MNEMONIC" \
  -v "$VOLUME:/state" -p 127.0.0.1:8545:8545 "$IMAGE" >/dev/null

for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
  sleep 1
done
echo "health: $(docker inspect -f '{{.State.Health.Status}}' "$NAME")  (the S2 healthcheck: cast block-number)"
echo "chain-id: $(cast chain-id --rpc-url "$RPC")"

# Account 0 is the deployer AND the treasury (spec S2). Derived from the
# mnemonic, the same way chain-svc derives it - NOT scraped from the node's
# startup banner, which is both a secret in `docker logs` and a dependency on
# output the node no longer produces now that it runs with -q. Deriving it also
# makes this script check the thing that matters: that the mnemonic really does
# control account 0 on the running chain.
KEY=$(cast wallet private-key --mnemonic "$MNEMONIC")
export DEPLOYER_PRIVATE_KEY="$KEY"
echo "treasury: $(cast wallet address --private-key "$KEY")"

step "deploy"
cd "$CONTRACTS_DIR"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast 2>&1 | grep -E "Deploy:|Compiler run|ONCHAIN EXECUTION|Error" | head -10
cat ../deployments/local.json

VEE=$(python3 -c "import json;print([m for m in json.load(open('../deployments/local.json'))['modules'] if m['kind']=='token'][0]['address'])")
REG=$(python3 -c "import json;print([m for m in json.load(open('../deployments/local.json'))['modules'] if m['kind']=='names'][0]['address'])")
TREASURY=$(cast wallet address --private-key "$KEY")

supply_before=$(cast call "$VEE" "totalSupply()(uint256)" --rpc-url "$RPC")
balance_before=$(cast call "$VEE" "balanceOf(address)(uint256)" "$TREASURY" --rpc-url "$RPC")
resolve_before=$(cast call "$REG" "resolve(string)(address)" "treasury.vee" --rpc-url "$RPC")
echo "totalSupply: $supply_before"
echo "treasury balance: $balance_before"
echo "resolve(treasury.vee): $resolve_before"

step "second run is idempotent (must NOT redeploy)"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast 2>&1 | grep -E "Deploy:|nothing to do" | head -5
VEE2=$(python3 -c "import json;print([m for m in json.load(open('../deployments/local.json'))['modules'] if m['kind']=='token'][0]['address'])")
[ "$VEE" = "$VEE2" ] || { echo "FAIL: token address changed: $VEE -> $VEE2"; exit 1; }
echo "token address unchanged: $VEE2"

step "the OTHER idempotence direction: local.json gone, chain intact (must REFUSE)"
# ./deployments is a bind mount and chain-state is a named volume, so either can
# outlive the other. Without this guard the script below deploys a SECOND token
# and writes it over the file, orphaning the first with every balance in it.
mv ../deployments/local.json /tmp/local.json.hidden
if forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast >/tmp/redeploy.log 2>&1; then
  mv /tmp/local.json.hidden ../deployments/local.json
  echo "FAIL: redeployed with no local.json - the live token has been orphaned"; exit 1
fi
grep -oE "refusing to redeploy[^\"]*" /tmp/redeploy.log | head -1
[ -f ../deployments/local.json ] && { echo "FAIL: it wrote a local.json anyway"; exit 1; }
echo "refused, and wrote no local.json"
mv /tmp/local.json.hidden ../deployments/local.json

step "the startup banner does not leak the treasury key"
# anvil prints the mnemonic and every private key unless -q. Account 0 is the
# treasury, and docker logs is not a secret store.
# Greps for the TWO LITERAL SECRETS, not for a shape. This used to match
# /private key|mnemonic|0x[0-9a-f]{64}/, which also matches every transaction
# and block hash anvil logs - so the number counted things that are not secrets
# (8 in a full run: 3 banner lines plus 5 from the deploy), and, worse, it would
# go quietly green the day anvil stopped printing the key banner for ANY reason,
# because it was measuring the shape of a log line rather than the presence of a
# credential. A control that can only fail loudly when things are fine is the
# thing this check exists to prevent.
secrets() { docker logs "$1" 2>&1 | grep -cF -e "$MNEMONIC" -e "$KEY" || true; }

leaks=$(secrets "$NAME")
[ "$leaks" = 0 ] || { echo "FAIL: the mnemonic or the treasury key appears $leaks times in docker logs"; exit 1; }
echo "mnemonic/treasury-key occurrences in docker logs: 0"
# The control, so that zero means something: the same grep against an
# unsuppressed banner must be non-zero.
docker run --rm -d --name "$NAME-noq" --entrypoint anvil "$IMAGE" \
  --host 0.0.0.0 --port 8545 --accounts 1 --mnemonic "$MNEMONIC" >/dev/null 2>&1
sleep 3
control=$(secrets "$NAME-noq")
docker rm -f "$NAME-noq" >/dev/null 2>&1
[ "$control" -gt 0 ] || { echo "FAIL: control found no leak either - the grep proves nothing"; exit 1; }
echo "control (same grep, no -q): $control"

step "restart (the S8 criterion 2 persistence check)"
docker restart "$NAME" >/dev/null
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
  sleep 1
done
echo "health after restart: $(docker inspect -f '{{.State.Health.Status}}' "$NAME")"

code_len=$(cast code "$VEE" --rpc-url "$RPC" | wc -c)
supply_after=$(cast call "$VEE" "totalSupply()(uint256)" --rpc-url "$RPC")
balance_after=$(cast call "$VEE" "balanceOf(address)(uint256)" "$TREASURY" --rpc-url "$RPC")
resolve_after=$(cast call "$REG" "resolve(string)(address)" "treasury.vee" --rpc-url "$RPC")
echo "token code bytes after restart: $code_len"
echo "totalSupply: $supply_after"
echo "treasury balance: $balance_after"
echo "resolve(treasury.vee): $resolve_after"

step "verdict"
fail=0
[ "$supply_before"  = "$supply_after"  ] || { echo "FAIL: totalSupply changed"; fail=1; }
[ "$balance_before" = "$balance_after" ] || { echo "FAIL: treasury balance changed"; fail=1; }
[ "$resolve_before" = "$resolve_after" ] || { echo "FAIL: treasury.vee resolution changed"; fail=1; }
[ "$code_len" -gt 10 ] || { echo "FAIL: token has no code after restart"; fail=1; }
[ "$fail" = 0 ] && echo "PASS: state survived the restart" || exit 1
