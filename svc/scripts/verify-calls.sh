#!/usr/bin/env bash
# §8.9. Runnable evidence for the generic call op, against a REAL chain.
#
# Everything below is reachable from a unit test except the things that are the
# point: that `forge script --broadcast` and the service agree about where the
# Converter is, that viem encodes a call the contract actually accepts, that a
# whole-unit amount arrives as the right number of smallest units, and that a
# revert comes back as a revert rather than as a receipt nobody read. Needs
# Docker and Foundry, so it cannot run in this repo's CI - run it by hand and
# paste the output:
#   ./svc/scripts/verify-calls.sh
set -euo pipefail

IMAGE=${IMAGE:-agent-chain-anvil:dev}
NAME=${NAME:-agent-chain-anvil-calls-verify}
VOLUME=${VOLUME:-agent-chain-state-calls-verify}
RPC=${RPC:-http://127.0.0.1:8545}
PORT=${PORT:-7003}
TOKEN=${CHAIN_SVC_TOKEN:-verify-token}
MNEMONIC="test test test test test test test test test test test junk"

HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$HERE/.."
CONTRACTS="$SVC/../contracts"
DEPLOYMENTS="$SVC/../deployments"
WORK=$(mktemp -d)
SVC_PID=""
FAIL=0
FAILED_CHECKS=""

step() { printf '\n=== %s\n' "$1"; }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then
    echo "  ok   $1: $2"
  else
    echo "  FAIL $1: got '$2' want '$3'"
    FAIL=1
    FAILED_CHECKS="$FAILED_CHECKS
    - $1: got '$2' want '$3'"
  fi
}

predown() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
cleanup() {
  [ -n "$SVC_PID" ] && kill "$SVC_PID" 2>/dev/null || true
  predown
  rm -rf "$WORK"
}
trap cleanup EXIT
predown

A=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')
api()  { curl -fsS "${A[@]}" "$@"; }
body() { curl -s "${A[@]}" "$@"; }
wbody() { local t=$1; shift; curl -s -H "Authorization: Bearer $t" -H 'content-type: application/json' "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)"; }

step "chain up + deploy two tokens, names and a converter"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -e ANVIL_MNEMONIC="$MNEMONIC" \
  -v "$VOLUME:/state" -p 127.0.0.1:8545:8545 "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break; sleep 1
done
rm -f "$DEPLOYMENTS/local.json"
# THE SHIPPED EXAMPLE, not a manifest written for this script. A smoke that
# deploys its own hand-built shape proves that shape works and says nothing
# about the one an operator would actually use.
cp "$DEPLOYMENTS/examples/two-tokens.json" "$DEPLOYMENTS/manifest.json"
# DERIVED FROM THE MNEMONIC, not scraped from `docker logs`. The image runs
# anvil with -q precisely so the banner's private keys never reach the log, so
# the scrape the older verify scripts still use finds nothing and the deploy
# fails with an unhelpful envUint parse error. Deriving it also checks the thing
# that matters: that this mnemonic really does control account 0 on this chain.
KEY=$(cast wallet private-key --mnemonic "$MNEMONIC")
( cd "$CONTRACTS" && DEPLOYER_PRIVATE_KEY="$KEY" DEPLOYMENTS_DIR="$DEPLOYMENTS" \
    forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast ) >/dev/null 2>&1

PLAY=$(python3 -c "import json;print([m for m in json.load(open('$DEPLOYMENTS/local.json'))['modules'] if m.get('key')=='play'][0]['address'])")
GOLD=$(python3 -c "import json;print([m for m in json.load(open('$DEPLOYMENTS/local.json'))['modules'] if m.get('key')=='gold'][0]['address'])")
CONV=$(python3 -c "import json;print([m for m in json.load(open('$DEPLOYMENTS/local.json'))['modules'] if m['kind']=='converter'][0]['address'])")
echo "  play=$PLAY gold=$GOLD converter=$CONV"

step "the allowlist"
mkdir -p "$WORK/policies"
# §2's example, verbatim except for the perTxCap the {arg} form requires.
cat > "$WORK/policies/calls.json" <<'CALLS_JSON'
{
  "schema": 1,
  "calls": [
    { "contract": "converter", "function": "convert",
      "kinds": ["org", "agent"],
      "amount": { "arg": 2, "token": { "arg": 0 } },
      "perTxCap": "100",
      "intentArg": 3,
      "maxPerStage": 20,
      "addressArgs": { "0": "token", "1": "token" } },
    { "contract": "converter", "function": "quote", "read": true, "kinds": ["org", "agent", "burner"],
      "addressArgs": { "0": "token", "1": "token" } },
    { "contract": "converter", "function": "pair",  "read": true, "kinds": ["org", "agent", "burner"],
      "addressArgs": { "0": "token", "1": "token" } },
    { "contract": "converter", "function": "setPair", "admin": true }
  ]
}
CALLS_JSON

( cd "$SVC" && RPC_URL="$RPC" CHAIN_SVC_TOKEN="$TOKEN" KEYSTORE_SECRET=verify-secret \
    ANVIL_MNEMONIC="$MNEMONIC" DEPLOYMENTS_DIR="$DEPLOYMENTS" KEYSTORE_DIR="$WORK/keystore" \
    POLICY_DIR="$WORK/policies" STORE_PATH="$WORK/store/db.sqlite" PORT="$PORT" \
    bun run src/index.ts ) >"$WORK/svc.log" 2>&1 &
SVC_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25
done
BASE="http://127.0.0.1:$PORT"

step "the registry reports the converter and both tokens"
check "contracts" \
  "$(body "$BASE/modules" | python3 -c "import sys,json;print(','.join(c['key'] for c in json.load(sys.stdin)['contracts']))")" \
  "play,gold,names,converter"

step "spawn an org wallet with 100 PLAY, and a burner"
ORG=$(api -X POST "$BASE/wallets" -d '{"agentId":"orch:org","kind":"org","fundVee":"100"}' | jget "['walletToken']")
BURNER=$(api -X POST "$BASE/wallets" -d '{"agentId":"orch:burn","kind":"burner","fundVee":"10"}' | jget "['walletToken']")
check "org balance before" "$(wbody "$ORG" "$BASE/balance/orch:org" | jget "['vee']")" "100"

step "the menu a persona reads"
check "org sees convert" \
  "$(wbody "$ORG" "$BASE/calls" | python3 -c "import sys,json;print(any(c['function']=='convert' for c in json.load(sys.stdin)['calls']))")" \
  "True"
check "burner does not" \
  "$(wbody "$BURNER" "$BASE/calls" | python3 -c "import sys,json;print(any(c['function']=='convert' for c in json.load(sys.stdin)['calls']))")" \
  "False"

step "read a view, free and signing nothing"
# THE RATE THE MANIFEST DECLARED, read back off the chain. 0.75 at 18 places.
check "pair(play,gold).rate" \
  "$(wbody "$ORG" -X POST "$BASE/read" -d '{"contract":"converter","function":"pair","args":[{"token":"play"},{"token":"gold"}]}' | python3 -c "import sys,json;print(json.load(sys.stdin)['result'].get('rate','NOT-KEYED-BY-NAME'))")" \
  "750000000000000000"

step "convert 40 PLAY to GOLD"
CALL=$(wbody "$ORG" -X POST "$BASE/call" \
  -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"40"],"intentId":"smoke-1"}')
check "call returned a tx" "$(echo "$CALL" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"
# THE WHOLE-UNITS QUESTION, answered against a real chain: "40" must leave 60,
# not 100 and not 0. A scale error anywhere in the path shows up here and
# nowhere in a unit test that asserts the reply.
check "org balance after" "$(wbody "$ORG" "$BASE/balance/orch:org" | jget "['vee']")" "60"

step "a replay of the same call sends nothing"
AGAIN=$(wbody "$ORG" -X POST "$BASE/call" \
  -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"40"],"intentId":"smoke-1"}')
check "same txHash" \
  "$(python3 -c "import json,sys;a=json.loads('''$CALL''');b=json.loads('''$AGAIN''');print(a['txHash']==b['txHash'])")" \
  "True"
check "balance unchanged" "$(wbody "$ORG" "$BASE/balance/orch:org" | jget "['vee']")" "60"

step "the same id with different arguments is refused"
check "invalid_request" \
  "$(wbody "$ORG" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"41"],"intentId":"smoke-1"}' | jget "['error']")" \
  "invalid_request"

step "a burner may not convert"
check "function_not_allowed" \
  "$(wbody "$BURNER" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"1"],"intentId":"smoke-b"}' | jget "['error']")" \
  "function_not_allowed"

step "a wallet may not pass a raw address"
check "bad_args" \
  "$(wbody "$ORG" -X POST "$BASE/call" -d "{\"contract\":\"converter\",\"function\":\"convert\",\"args\":[\"$PLAY\",{\"token\":\"gold\"},\"1\"],\"intentId\":\"smoke-raw\"}" | jget "['error']")" \
  "bad_args"

step "admin-call: the hub sets a rate"
OK=$(body -X POST "$BASE/admin-call" -d "{\"contract\":\"converter\",\"function\":\"setPair\",\"args\":[\"$GOLD\",\"$PLAY\",\"1000000000000000000\"],\"intentId\":\"smoke-rate\"}")
check "admin-call returned a tx" "$(echo "$OK" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"
check "the new rate is on chain" \
  "$(wbody "$ORG" -X POST "$BASE/read" -d '{"contract":"converter","function":"pair","args":[{"token":"gold"},{"token":"play"}]}' | python3 -c "import sys,json;print(json.load(sys.stdin)['result'].get('rate','NOT-KEYED-BY-NAME'))")" \
  "1000000000000000000"

step "admin-call: the loop guard refuses a rate that mints value round the loop"
# 1.5e18 gold->play against the existing 0.75e18 play->gold mints value round
# the loop, and the Converter refuses it. The REASON must be in chain-svc's log
# and NOT in the reply.
REV=$(body -X POST "$BASE/admin-call" -d "{\"contract\":\"converter\",\"function\":\"setPair\",\"args\":[\"$GOLD\",\"$PLAY\",\"1500000000000000000\"],\"intentId\":\"smoke-admin\"}")
check "revert" "$(echo "$REV" | jget "['error']")" "revert"
check "no reason in the reply" "$(echo "$REV" | grep -ci 'loop' || true)" "0"
check "reason in the log" "$(grep -c 'setPair on converter reverted' "$WORK/svc.log" || true)" "1"

step "a wallet credential may not admin-call"
check "wrong_scope" \
  "$(wbody "$ORG" -X POST "$BASE/admin-call" -d "{\"contract\":\"converter\",\"function\":\"setPair\",\"args\":[\"$GOLD\",\"$PLAY\",\"1\"],\"intentId\":\"smoke-x\"}" | jget "['error']")" \
  "wrong_scope"

step "the event feed carries the call, with the names the caller used"
# A CHECK THAT COMPARES A VALUE TO ITSELF IS NOT A CHECK - the first draft of
# this one grepped the same file on both sides and could not fail.
#
# chain-svc has no /events endpoint: events go to the OUTBOX and are delivered
# to hub-core, which does not exist yet. So the outbox is read where it lives,
# which is also the honest thing to assert - the feed is what a facilitator
# will receive, not what a log line says.
sleep 2
check "agent.call carries the caller's words, not addresses" \
  "$(python3 - <<PYEOF
import json, sqlite3
db = sqlite3.connect("$WORK/store/db.sqlite")
rows = [r[0] for r in db.execute("SELECT payload FROM outbox ORDER BY id")]
calls = [json.loads(p) for p in rows]
calls = [c for c in calls if c.get("kind") == "agent.call"]
if not calls:
    print("no-agent.call-event")
else:
    c = calls[0]
    problems = []
    if c.get("contract") != "converter": problems.append("contract=%s" % c.get("contract"))
    if c.get("function") != "convert": problems.append("function=%s" % c.get("function"))
    if c.get("args") != [{"token": "play"}, {"token": "gold"}, "40"]: problems.append("args=%s" % c.get("args"))
    if c.get("status") != "ok": problems.append("status=%s" % c.get("status"))
    if c.get("amount") != {"value": "40", "token": "play"}: problems.append("amount=%s" % c.get("amount"))
    # THE RULE THE EVENT EXISTS TO KEEP: names and keys, never addresses.
    if "$PLAY".lower() in json.dumps(c).lower(): problems.append("leaks the play address")
    print("True" if not problems else ", ".join(problems))
PYEOF
)" \
  "True"

step "hub.call is emitted for the operator's action too"
# THE SUCCESSFUL one. Whether a SIMULATION-REFUSED admin-call should also emit
# an event is an open question - nothing was mined, so `status: "reverted"` with
# a txHash would be a lie about what happened - and it is powerout-planner's to
# rule. What is not in question is that the operator's REAL action reaches the
# feed, which is what this asserts.
check "hub.call recorded" \
  "$(python3 - <<PYEOF
import json, sqlite3
db = sqlite3.connect("$WORK/store/db.sqlite")
rows = [json.loads(r[0]) for r in db.execute("SELECT payload FROM outbox ORDER BY id")]
hub = [r for r in rows if r.get("kind") == "hub.call"]
if not hub:
    print("no-hub.call-event")
else:
    h = hub[0]
    print("%s/%s/%s" % (h.get("contract"), h.get("function"), h.get("status")))
PYEOF
)" \
  "converter/setPair/ok"

step "the hub's REFUSED action reaches the feed too"
# Ruled: a simulation-refused admin-call emits hub.call with a null hash and
# status "refused" - a third value beside ok and reverted. Nothing was mined, so
# a null hash under "reverted" would lie; silence would hide the hub trying
# something the chain would not accept.
check "hub.call refused" \
  "$(python3 - <<PYEOF
import json, sqlite3
db = sqlite3.connect("$WORK/store/db.sqlite")
rows = [json.loads(r[0]) for r in db.execute("SELECT payload FROM outbox ORDER BY id")]
hub = [r for r in rows if r.get("kind") == "hub.call" and r.get("status") == "refused"]
if not hub:
    print("no-refused-event")
else:
    print("%s/%s" % (hub[0].get("function"), hub[0].get("txHash")))
PYEOF
)" \
  "setPair/None"

printf '\n'
if [ "$FAIL" = 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "FAILURES:$FAILED_CHECKS"
  echo
  echo "--- chain-svc log ---"
  tail -40 "$WORK/svc.log"
fi
exit "$FAIL"
