#!/usr/bin/env bash
# Runnable evidence for spec S8 criterion 2 IN FULL (the /supply half needs
# chain-svc, which is why C1b could only do the Anvil half) and for the
# Otterscan acceptance check. Needs Docker; run by hand and paste the output:
#   ./docker/verify-compose.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"       # the repo root
export ANVIL_MNEMONIC=${ANVIL_MNEMONIC:-"test test test test test test test test test test test junk"}
# FINDING 16: NO DEFAULT SECRETS, and the reason is that these two are not
# "test values" - they are the SAME NAMES the real deployment uses.
#
# `${VAR:-default}` invented a token and a keystore passphrase when the
# environment had none, so a run against a stack that was already up used a
# credential nobody configured: it failed with 401s that look like a broken
# service, or - worse - a fresh stack came up encrypted under
# `compose-verify-secret`, a passphrase now sitting in this file in a public
# repository, holding real wallet keys for as long as that volume lives.
#
# `${VAR:?}` is what compose.chain.yml itself uses for both. The script now
# refuses with the variable's name rather than inventing a value, which is the
# same contract one layer up.
export CHAIN_SVC_TOKEN=${CHAIN_SVC_TOKEN:?set CHAIN_SVC_TOKEN, as compose requires; this script will not invent one}
export KEYSTORE_SECRET=${KEYSTORE_SECRET:?set KEYSTORE_SECRET, as compose requires; it encrypts every wallet key this stack creates}
# AND ITS OWN PROJECT NAME. Without `-p`, compose derives the project from the
# first -f file's directory - the repo root - so this verification shared a
# project with whatever else was running from here, and its `down` at the end
# stopped that too. Named, so the verify stack is a stack of its own.
COMPOSE=(docker compose -p agent-chain-verify -f "$HERE/compose.chain.yml" --profile chain)
FAIL=0
FAILED_CHECKS=""

step()  { printf '\n=== %s\n' "$1"; }
check() {
  if [ "$2" = "$3" ]; then echo "  ok   $1: $2"; else
    echo "  FAIL $1: got '$2' want '$3'"; FAIL=1
    FAILED_CHECKS="$FAILED_CHECKS
    - $1: got '$2' want '$3'"
  fi
}
cleanup() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
rm -f "$HERE/deployments/local.json"

A=(-H "Authorization: Bearer $CHAIN_SVC_TOKEN")

step "cold start"
START=$(date +%s)
"${COMPOSE[@]}" up -d --build >/dev/null 2>&1
# Criterion 2 gives 30s from a cold start to a served /supply.
SUPPLY=""
for _ in $(seq 1 30); do
  SUPPLY=$(curl -fsS "${A[@]}" http://127.0.0.1:7000/supply 2>/dev/null) && break
  sleep 1
done
ELAPSED=$(( $(date +%s) - START ))
echo "  services: $("${COMPOSE[@]}" ps --format '{{.Service}}:{{.State}}' | tr '\n' ' ')"
echo "  GET /supply after ${ELAPSED}s -> $SUPPLY"
check "supply total"        "$(echo "$SUPPLY" | python3 -c "import sys,json;print(json.load(sys.stdin)['total'])")" "1000000"
[ "$ELAPSED" -le 30 ] && echo "  ok   within the 30s cold-start bound" || { echo "  FAIL took ${ELAPSED}s"; FAIL=1; }

step "deploy ran exactly once, as a one-shot"
check "chain-deploy exited 0" "$("${COMPOSE[@]}" ps -a --format '{{.Service}}:{{.ExitCode}}' | sed -n 's/^chain-deploy://p')" "0"

step "state persists across a restart (criterion 2, second half)"
BEFORE=$(curl -fsS "${A[@]}" http://127.0.0.1:7000/supply)
"${COMPOSE[@]}" restart chain >/dev/null 2>&1
for _ in $(seq 1 30); do curl -fsS "${A[@]}" http://127.0.0.1:7000/supply >/dev/null 2>&1 && break; sleep 1; done
AFTER=$(curl -fsS "${A[@]}" http://127.0.0.1:7000/supply)
echo "  before: $BEFORE"
echo "  after:  $AFTER"
check "supply unchanged" "$AFTER" "$BEFORE"

step "otterscan (both halves - a served page that cannot reach the chain must not pass)"
OTS_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5100/)
check "frontend served" "$OTS_CODE" "200"
# The page fetches config.json and then dials the RPC from the BROWSER, so the
# published port is what has to answer - curling the frontend proves nothing
# about that.
CONFIG=$(curl -fsS http://127.0.0.1:5100/config.json)
echo "  config.json -> $CONFIG"
# Parsed as JSON, not by pattern: the entrypoint writes it with jq, which
# spaces its output, and a sed pattern that assumed otherwise reported an
# empty value as a mismatch rather than as a broken matcher.
check "erigonURL is the published port" "$(echo "$CONFIG" | python3 -c "import sys,json;print(json.load(sys.stdin)['erigonURL'])")" "http://127.0.0.1:8545"
OTS_LEVEL=$(curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"ots_getApiLevel","params":[]}' http://127.0.0.1:8545 \
  | sed -n 's/.*"result":\([0-9]*\).*/\1/p')
echo "  ots_getApiLevel on the published RPC -> $OTS_LEVEL"
[ -n "$OTS_LEVEL" ] && echo "  ok   the browser's RPC target answers the ots_* namespace" \
  || { echo "  FAIL ots_getApiLevel did not answer"; FAIL=1; }

step "the unauthenticated route exposes liveness and nothing else"
echo "  GET /health -> $(curl -fsS http://127.0.0.1:7000/health)"
check "no supply without a token" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7000/supply)" "401"

step "verdict"
if [ "$FAIL" = 0 ]; then
  echo "PASS: criterion 2 in full, and the Otterscan acceptance check"
else
  echo "FAIL. Checks that failed:$FAILED_CHECKS"
  exit 1
fi
