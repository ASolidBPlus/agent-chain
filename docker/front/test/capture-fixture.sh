#!/usr/bin/env bash
# Captures a REAL `Registered` log from a live chain and prints the fixture
# block that njs-units.js embeds.
#
# WHY A CAPTURED FIXTURE RATHER THAN A WRITTEN ONE. The decoder's whole job is to
# read what the node emits. A fixture assembled by hand tests it against its
# author's idea of the ABI encoding - and an author who got the encoding wrong
# writes a fixture that agrees with the bug. This takes the bytes off a chain
# that really ran the contract.
#
# Needs Docker. Run it by hand when the event's shape changes, paste the block
# it prints into njs-units.js, and say in the commit which chain it came from.
#
#   ./docker/front/test/capture-fixture.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
NAME=${NAME:-agent-chain-fixture}
export ANVIL_MNEMONIC=${ANVIL_MNEMONIC:-"test test test test test test test test test test test junk"}
export CHAIN_SVC_TOKEN=${CHAIN_SVC_TOKEN:-fixture-token}
export KEYSTORE_SECRET=${KEYSTORE_SECRET:-fixture-secret}
COMPOSE=(docker compose -p "$NAME" -f "$HERE/compose.chain.yml" --profile chain)

# THE DEVELOPER'S MANIFEST IS MOVED ASIDE AND PUT BACK, the same treatment
# verify-compose.sh gets. This script needs a COLD deploy - a `local.json` left
# by any previous run records addresses this fresh chain does not have, and the
# deploy refuses by name (correctly: that guard is what stops a stale cache
# being treated as an authority). Deleting the file would take the developer's
# own deployment record with it.
STASHED="$HERE/deployments/local.json.fixture-stash"
restore_manifest() {
  [ -f "$STASHED" ] && mv "$STASHED" "$HERE/deployments/local.json"
}
cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  restore_manifest
}
trap cleanup EXIT
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
[ -f "$HERE/deployments/local.json" ] && mv "$HERE/deployments/local.json" "$STASHED"

echo "=== bringing up a chain" >&2
"${COMPOSE[@]}" up -d --build >/dev/null 2>&1 || { echo "the stack did not come up" >&2; exit 1; }

for _ in $(seq 1 60); do
  curl -fsS -H "Authorization: Bearer $CHAIN_SVC_TOKEN" http://127.0.0.1:7000/health >/dev/null 2>&1 && break
  sleep 1
done

# A spawn is what registers a name, so this is the ordinary path rather than a
# contrived one: the log below is the one a real deployment produces.
FIXTURE_NAME="fixture:sample"
echo "=== registering $FIXTURE_NAME" >&2
curl -fsS -H "Authorization: Bearer $CHAIN_SVC_TOKEN" -H 'content-type: application/json' \
  -X POST http://127.0.0.1:7000/wallets \
  -d "{\"agentId\":\"$FIXTURE_NAME\",\"kind\":\"agent\"}" >/dev/null

REGISTRY=$(python3 -c "
import json
m = json.load(open('$HERE/deployments/local.json'))['modules']
print([x for x in m if x['kind'] == 'names'][0]['address'])
")
TARGET=$(curl -fsS -H "Authorization: Bearer $CHAIN_SVC_TOKEN" \
  "http://127.0.0.1:7000/wallets/$(python3 -c "import urllib.parse;print(urllib.parse.quote('$FIXTURE_NAME', safe=''))")" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['address'])")

TOPIC=0x89e10b169d87e3f3c9c0cf7d190f5777367907b57ce823d5422007ca31f71986

# Straight off the chain. `--json` so the data field is unambiguous.
#
# THE LAST LOG, NOT THE FIRST. The deploy registers `treasury.play` before this
# script registers anything, so [0] is that one - and the first version of this
# script printed ITS data under THIS script's name and address. A fixture whose
# label disagrees with its bytes is worse than no fixture: it fails for a reason
# that has nothing to do with the decoder, or it gets "fixed" by editing the
# label until the two agree on something false.
DATA=$("${COMPOSE[@]}" exec -T chain cast logs --rpc-url http://localhost:8545 \
  --address "$REGISTRY" "$TOPIC" --json 2>/dev/null \
  | python3 -c "import sys,json;print(json.load(sys.stdin)[-1]['data'])")

# DECODED BY A DIFFERENT DECODER. The expected values must not come from the
# decoder under test, or the fixture agrees with whatever that decoder does -
# including being wrong. `cast abi-decode` reads the same captured bytes with
# foundry's implementation, so njs-units.js compares two independent readings of
# one real log.
DECODED=$(docker run --rm --entrypoint cast ghcr.io/foundry-rs/foundry:latest \
  abi-decode "f()(string,address,address)" "$DATA")
DEC_NAME=$(echo "$DECODED" | sed -n '1p' | tr -d '"')
DEC_TARGET=$(echo "$DECODED" | sed -n '3p' | tr '[:upper:]' '[:lower:]')

if [ "$DEC_NAME" != "$FIXTURE_NAME" ]; then
  echo "capture failed: the log decodes to '$DEC_NAME', not the name this script registered" >&2
  exit 1
fi

echo >&2
echo "// Captured from a live chain by capture-fixture.sh, decoded by cast." >&2
cat <<BLOCK
var REAL_LOG_DATA = '$DATA';
var REAL_LOG_NAME = '$DEC_NAME';
var REAL_LOG_TARGET = '$DEC_TARGET';
BLOCK
