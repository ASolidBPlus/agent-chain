#!/usr/bin/env bash
# Runnable evidence for spec S8 criterion 2 IN FULL (the /supply half needs
# chain-svc, which is why C1b could only do the Anvil half) and for the
# Otterscan acceptance check. Needs Docker; run by hand and paste the output:
#   ./docker/verify-compose.sh
set -euo pipefail

# PARCEL B: A QUIET STEP THAT SPEAKS WHEN IT FAILS.
#
# `up -d --build >/dev/null 2>&1` discarded the reason, so a failure inside it
# left `set -e` killing the script with the log ending at "=== cold start" and
# nothing to read. Measured on this branch, twice: a compose interpolation error
# and a container that would not start both arrived as a script that simply
# stopped.
#
# NO `trap ... EXIT` here: this script already sets one to bring the stack down,
# and a second trap on the same signal REPLACES the first - so a helper that
# installed one would leave a stack running. The log is per call.
quietly() { # quietly <label> <cmd...> - prints the command's output only if it fails
  local label=$1; shift
  local log; log=$(mktemp)
  if ! "$@" >"$log" 2>&1; then
    echo "FAIL: $label" >&2
    echo "--- last 40 lines ---" >&2
    tail -40 "$log" >&2
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
}

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
# FINDING 29's CLASS, one file over. This script needs a cold start, and a cold
# start needs no local.json - but the file it was deleting is the DEVELOPER'S,
# recording whatever they had deployed. verify-chain.sh stages into a mktemp dir
# and touches nothing; this one cannot, because the manifest reaches the
# containers through a bind mount that compose.chain.yml declares.
#
# So: MOVED ASIDE AND PUT BACK, rather than deleted or guarded behind a flag. A
# force flag would make the ordinary invocation the one that needs remembering,
# and the destruction it gates is not something anybody wants even once.
#
# Restored in `cleanup`, which runs on the EXIT trap - so it comes back whether
# the script passes, fails, or is interrupted. `cleanup` runs once before the
# stack comes up too, and the guard is what makes that call harmless.
STASHED="$HERE/deployments/local.json.verify-stash"
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

A=(-H "Authorization: Bearer $CHAIN_SVC_TOKEN")

step "cold start"
START=$(date +%s)
quietly "compose up --build" "${COMPOSE[@]}" up -d --build
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
quietly "compose restart chain" "${COMPOSE[@]}" restart chain
for _ in $(seq 1 30); do curl -fsS "${A[@]}" http://127.0.0.1:7000/supply >/dev/null 2>&1 && break; sleep 1; done
AFTER=$(curl -fsS "${A[@]}" http://127.0.0.1:7000/supply)
echo "  before: $BEFORE"
echo "  after:  $AFTER"
check "supply unchanged" "$AFTER" "$BEFORE"

step "a chain that has been SPENT FROM can still be brought back up"
# THE SEQUENCE THAT BLOCKED A DEPLOYMENT, and it is a restart rather than a
# restart of one service: `down` without `-v` keeps the volumes, so `up` runs
# chain-deploy again over an intact chain and takes the idempotency path. That
# path used to require the treasury to still hold its entire initial supply -
# true only of a chain nobody has used - so one funded wallet made every later
# `up` fail: chain-deploy exited 1, compose reported `service "chain-deploy"
# didn't complete successfully`, and chain-svc never left `created`. A used
# chain could not be restarted at all, and discarding the chain state was the
# only way out, which is what the idempotency path exists to avoid.
#
# The spend is the whole fixture: without it this is just the cold start again.
quietly "spawn a wallet to fund" curl -fsS "${A[@]}" -H 'content-type: application/json' \
  -X POST http://127.0.0.1:7000/wallets -d '{"agentId":"restart:probe","kind":"agent"}'
quietly "fund it from the treasury" curl -fsS "${A[@]}" -H 'content-type: application/json' \
  -X POST http://127.0.0.1:7000/fund \
  -d '{"to":"restart:probe","amount":"1","intentId":"restart-probe-fund"}'
SPENT=$(curl -fsS "${A[@]}" http://127.0.0.1:7000/supply)
echo "  after funding: $SPENT"

quietly "compose down (volumes kept)" "${COMPOSE[@]}" down
# NOT `quietly`, WHICH WOULD ABORT THE SCRIPT. When the defect is present this
# `up` exits non-zero - that is the symptom - and the checks below are what
# describe it. Its output is kept and shown, because a compose failure here is
# the thing being measured rather than an accident.
UPLOG=$(mktemp)
"${COMPOSE[@]}" up -d >"$UPLOG" 2>&1 || {
  echo "  compose up exited $? -- last lines:"
  tail -5 "$UPLOG" | sed 's/^/    /'
}
rm -f "$UPLOG"
for _ in $(seq 1 45); do curl -fsS "${A[@]}" http://127.0.0.1:7000/supply >/dev/null 2>&1 && break; sleep 1; done
# THE DEPLOY'S EXIT CODE, not just "the service came back": a chain-deploy that
# exits 1 is what compose refuses to proceed past, so this is the fact.
check "chain-deploy exited 0 over a used chain" \
  "$("${COMPOSE[@]}" ps -a --format '{{.Service}}:{{.ExitCode}}' | sed -n 's/^chain-deploy://p')" "0"
check "chain-svc is running, not stuck in created" \
  "$("${COMPOSE[@]}" ps --format '{{.Service}}:{{.State}}' | sed -n 's/^chain-svc://p')" "running"
check "the supply is the one the spend left behind" \
  "$(curl -fsS "${A[@]}" http://127.0.0.1:7000/supply)" "$SPENT"

step "otterscan (both halves - a served page that cannot reach the chain must not pass)"
OTS_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5100/)
check "frontend served" "$OTS_CODE" "200"
# The page fetches config.json and then dials the RPC from the BROWSER, so what
# that file NAMES is what has to answer - curling the frontend proves nothing
# about that.
CONFIG=$(curl -fsS http://127.0.0.1:5100/config.json)
echo "  config.json -> $CONFIG"
# Parsed as JSON, not by pattern: the entrypoint writes it with jq, which
# spaces its output, and a sed pattern that assumed otherwise reported an
# empty value as a mismatch rather than as a broken matcher.
ERIGON=$(echo "$CONFIG" | python3 -c "import sys,json;print(json.load(sys.stdin)['erigonURL'])")
# SAME ORIGIN AS THE PAGE, which is the change the `front` service made: the
# node publishes no host port at all now, and the explorer's RPC is a path
# beside it rather than a second published port. This check asserted
# `http://127.0.0.1:8545` and went red on exactly that, which is the red it
# should have produced.
check "erigonURL is the page's own origin" "$ERIGON" "http://127.0.0.1:5100/rpc"
# DIALLED AT THE ADDRESS config.json GAVE, not at a port written here. The
# browser has no other source, so a check against a literal is a check on
# something the browser does not do - and that is how the assertion above came
# to outlive the topology it described.
OTS_LEVEL=$(curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"ots_getApiLevel","params":[]}' "$ERIGON" \
  | sed -n 's/.*"result":\([0-9]*\).*/\1/p')
echo "  ots_getApiLevel at the advertised RPC ($ERIGON) -> $OTS_LEVEL"
[ -n "$OTS_LEVEL" ] && echo "  ok   the browser's RPC target answers the ots_* namespace through the filter" \
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
