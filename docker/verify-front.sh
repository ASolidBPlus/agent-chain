#!/usr/bin/env bash
# Runnable evidence for the `front` service: the node and the explorer have no
# host binding at all, and everything that reaches them from outside goes
# through the filter first. Needs Docker; run by hand and paste the output:
#   CHAIN_SVC_TOKEN=... KEYSTORE_SECRET=... ./docker/verify-front.sh
#
# WHY A LIVE SCRIPT WHEN THE UNIT TESTS ARE GOOD. njs-units.js runs the decoder
# and the matcher directly and says which one is wrong - but it cannot see the
# two facts this service exists for, because neither is in a function. That the
# node has no published port is a property of compose; that a refusal is a
# refusal RATHER THAN A -32601 REPLY TO A CALL THAT ALREADY RAN is a property of
# nginx, njs and anvil together. Both are checked here against a running stack.
#
# Publishes the same loopback ports as verify-compose.sh, so the two cannot run
# at once.
set -euo pipefail

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

HERE="$(cd "$(dirname "$0")/.." && pwd)"
export ANVIL_MNEMONIC=${ANVIL_MNEMONIC:-"test test test test test test test test test test test junk"}
# The same contract as compose and verify-compose.sh: refuse with the variable's
# name rather than invent a credential that then encrypts real wallet keys.
export CHAIN_SVC_TOKEN=${CHAIN_SVC_TOKEN:?set CHAIN_SVC_TOKEN, as compose requires; this script will not invent one}
export KEYSTORE_SECRET=${KEYSTORE_SECRET:?set KEYSTORE_SECRET, as compose requires; it encrypts every wallet key this stack creates}
IMAGE=otterscan/otterscan:v2.11.0
PROJECT=agent-chain-front
COMPOSE=(docker compose -p "$PROJECT" -f "$HERE/compose.chain.yml" --profile chain)
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
note()  { echo "  ok   $1"; }
bad()   { echo "  FAIL $1"; FAIL=1; FAILED_CHECKS="$FAILED_CHECKS
    - $1"; }

# The developer's manifest is moved aside and put back, for the reason spelled
# out at length in verify-compose.sh: this needs a cold deploy, and the file a
# cold deploy must not find is somebody's own deployment record.
STASHED="$HERE/deployments/local.json.front-stash"
cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  [ -f "$STASHED" ] && mv "$STASHED" "$HERE/deployments/local.json"
  return 0
}
trap cleanup EXIT
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
[ -f "$HERE/deployments/local.json" ] && mv "$HERE/deployments/local.json" "$STASHED"

RPC=http://127.0.0.1:8545
WEB=http://127.0.0.1:5100
post() { # post <url> <json> - the raw body, no -f, because refusals are 200s
  curl -s -X POST -H 'content-type: application/json' --data "$2" "$1"
}
jqp() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

step "cold start"
quietly "compose up --build" "${COMPOSE[@]}" up -d --build
for _ in $(seq 1 45); do
  curl -fsS -H "Authorization: Bearer $CHAIN_SVC_TOKEN" http://127.0.0.1:7000/supply >/dev/null 2>&1 && break
  sleep 1
done
echo "  services: $("${COMPOSE[@]}" ps --format '{{.Service}}:{{.State}}' | tr '\n' ' ')"

# --------------------------------------------------------------------------
step "the node and the explorer have NO host binding (the premise of the service)"
# A filter beside a published node port is decorative, so this is checked before
# anything the filter does. `docker port` lists what a container publishes; the
# expected answer for both is nothing at all.
for svc in chain otterscan; do
  CID=$("${COMPOSE[@]}" ps -q "$svc")
  BOUND=$(docker port "$CID" 2>/dev/null | tr '\n' ' ')
  check "$svc publishes nothing" "${BOUND:-(none)}" "(none)"
done
# ...and the front does, on both. Stated as the value rather than as non-empty:
# "something is bound" passes for a binding on the wrong port.
FRONT=$("${COMPOSE[@]}" ps -q front)
echo "  front publishes: $(docker port "$FRONT" | tr '\n' ' ')"
check "front publishes 8545" "$(docker port "$FRONT" 8545/tcp)" "127.0.0.1:8545"
check "front publishes 80"   "$(docker port "$FRONT" 80/tcp)"   "127.0.0.1:5100"

step "an allowed method reaches the node and returns the NODE'S answer"
# 0x7a69 is 31337. Compared to the value, not to "a result is present": a filter
# that answered every allowed call with an empty result would pass that.
check "eth_chainId on :8545" \
  "$(post "$RPC" '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' | jqp "print(d['result'])")" "0x7a69"
check "eth_chainId on :5100/rpc" \
  "$(post "$WEB/rpc" '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' | jqp "print(d['result'])")" "0x7a69"

step "an admin method is refused AND DID NOT HAPPEN"
# THE CHECK THIS SCRIPT EXISTS FOR. A -32601 in the reply proves what the filter
# said, not what the node did - and a filter that returned the refusal while
# still forwarding the call would satisfy every assertion about the error object
# and none about the chain. So: read a balance, try to set it to a value it
# cannot already hold, read it again.
# A well-formed address that holds nothing. WRITTEN OUT TO FORTY HEX DIGITS and
# checked here, because the first version of this line was thirty-nine: anvil
# refused `eth_getBalance` as bad params, and a refusal from the NODE arriving in
# the middle of a step about refusals from the FILTER is the most misleading
# possible failure. The guard costs a line and names the real fault.
VICTIM=0x000000000000000000000000000000000000bad1
[ ${#VICTIM} -eq 42 ] || { echo "the victim address is malformed (${#VICTIM} chars, want 42)"; exit 1; }
bal() { # prints the raw reply; the caller parses it
  post "$RPC" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$VICTIM\",\"latest\"]}"
}
BEFORE_RAW=$(bal); echo "  balance before -> $BEFORE_RAW"
BEFORE=$(echo "$BEFORE_RAW" | jqp "print(d['result'])")
ATTEMPT=$(post "$RPC" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"anvil_setBalance\",\"params\":[\"$VICTIM\",\"0xde0b6b3a7640000\"]}")
AFTER_RAW=$(bal)
AFTER=$(echo "$AFTER_RAW" | jqp "print(d['result'])")
echo "  attempt -> $ATTEMPT"
echo "  balance after  -> $AFTER_RAW"
check "the refusal is -32601"      "$(echo "$ATTEMPT" | jqp "print(d['error']['code'])")" "-32601"
check "...and names the method"    "$(echo "$ATTEMPT" | jqp "print('anvil_setBalance' in d['error']['message'])")" "True"
check "no result field is present" "$(echo "$ATTEMPT" | jqp "print('result' in d)")" "False"
check "the balance was 0 before"   "$BEFORE" "0x0"
check "AND IS STILL 0 after"       "$AFTER"  "0x0"

# The same call on the explorer's origin: two server blocks share this config by
# duplication, and duplicated config is where drift lives.
check "refused on :5100/rpc too" \
  "$(post "$WEB/rpc" '{"jsonrpc":"2.0","id":1,"method":"anvil_setBalance","params":["'"$VICTIM"'","0x1"]}' | jqp "print(d['error']['code'])")" "-32601"

step "one refused call in a batch does not move the answers beside it"
BATCH=$(post "$RPC" '[{"jsonrpc":"2.0","id":"a","method":"eth_chainId"},
                      {"jsonrpc":"2.0","id":"b","method":"anvil_mine"},
                      {"jsonrpc":"2.0","id":"c","method":"net_version"}]')
echo "  batch -> $BATCH"
check "slot 0 is the chain id"       "$(echo "$BATCH" | jqp "print(d[0]['result'])")"      "0x7a69"
check "slot 1 is the refusal"        "$(echo "$BATCH" | jqp "print(d[1]['error']['code'])")" "-32601"
check "slot 2 is the net version"    "$(echo "$BATCH" | jqp "print(d[2]['result'])")"      "31337"
check "ids are preserved per slot"   "$(echo "$BATCH" | jqp "print(','.join(x['id'] for x in d))")" "a,b,c"

step "the internal node location is not a route"
for u in "$RPC/__node" "$WEB/__node"; do
  check "$u is not reachable" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"anvil_mine"}' "$u")" "404"
done

step "the explorer is served, and its RPC target is the origin it loaded from"
check "frontend served through the front" "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/")" "200"
CONFIG=$(curl -fsS "$WEB/config.json")
echo "  config.json -> $CONFIG"
ERIGON=$(echo "$CONFIG" | jqp "print(d['erigonURL'])")
check "erigonURL is same-origin" "$ERIGON" "http://127.0.0.1:5100/rpc"
# ...and that URL answers, rather than merely being well-formed.
check "and the URL it names answers" \
  "$(post "$ERIGON" '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' | jqp "print(d['result'])")" "0x7a69"

step "config.json takes its scheme from the proxy when there is one"
# Behind a gateway that terminates TLS, `$scheme` here is http - the scheme of
# the hop between the gateway and this container - so an advertised http RPC on
# an https page is blocked by the browser and the explorer sits there failing.
check "no forwarded header -> the scheme of the request" \
  "$(curl -fsS "$WEB/config.json" | jqp "print(d['erigonURL'])")" "http://127.0.0.1:5100/rpc"
check "X-Forwarded-Proto: https -> https" \
  "$(curl -fsS -H 'X-Forwarded-Proto: https' "$WEB/config.json" | jqp "print(d['erigonURL'])")" \
  "https://127.0.0.1:5100/rpc"
# ...and the host follows the request too, which is what makes an ssh forward on
# a different port work without configuring anything.
check "the advertised host follows the request" \
  "$(curl -fsS -H 'Host: elsewhere.example:9999' "$WEB/config.json" | jqp "print(d['erigonURL'])")" \
  "http://elsewhere.example:9999/rpc"

step "the config is a TEMPLATE, and its five values are values"
# The consumer that cannot resolve service names and cannot choose its ports
# needs these to be settable without keeping a copy of the config. Rendered here
# with non-default values, and read back out of the rendered file.
REND=$(docker run --rm -e NODE_UPSTREAM=http://127.0.0.1:9999 -e OTTERSCAN_UPSTREAM=http://127.0.0.1:9998 \
  -e FRONT_HTTP_PORT=18080 -e FRONT_RPC_PORT=18545 -e ERIGON_URL=https://chain.example.com/rpc \
  -v "$HERE/docker/front/rpc-proxy.conf.template:/etc/nginx/rpc-proxy.conf.template:ro" \
  -v "$HERE/docker/front/entrypoint.sh:/entrypoint.sh:ro" \
  -v "$HERE/docker/front/rpc_filter.js:/etc/nginx/njs/rpc_filter.js:ro" \
  -v "$HERE/docker/front/overview.js:/etc/nginx/njs/overview.js:ro" \
  --entrypoint sh "$IMAGE" -c 'head -n -1 /entrypoint.sh > /tmp/e.sh; sh /tmp/e.sh >/dev/null 2>&1; cat /tmp/rpc-proxy.conf')
for want in "listen 18080;" "listen 18545;" 'set $node "http://127.0.0.1:9999";' \
            'set $otterscan "http://127.0.0.1:9998";' 'erigonURL":"https://chain.example.com/rpc'; do
  case "$REND" in
    *"$want"*) note "rendered: $want" ;;
    *) bad "the template did not honour: $want" ;;
  esac
done
# THE CONTROL FOR THE GUARD IN THE ENTRYPOINT. Called without its explicit
# variable list, envsubst eats nginx's own variables and the result is a valid
# config that proxies nowhere - which `nginx -t` cannot see. The guard must
# refuse; if it ever stops refusing, this goes red rather than the deployment.
GUARD=$(docker run --rm \
  -v "$HERE/docker/front/rpc-proxy.conf.template:/etc/nginx/rpc-proxy.conf.template:ro" \
  -v "$HERE/docker/front/entrypoint.sh:/entrypoint.sh:ro" \
  --entrypoint sh "$IMAGE" -c 'head -n -1 /entrypoint.sh | sed "s/^envsubst .*/envsubst \\\\/" > /tmp/e.sh; sh /tmp/e.sh 2>&1; echo "exit=$?"' 2>&1)
echo "  guard says: $(echo "$GUARD" | head -1)"
case "$GUARD" in
  *"envsubst consumed"*"exit=1"*) note "a wrong variable list is refused at startup, not served" ;;
  *) bad "the envsubst guard did not fire on a wrong variable list" ;;
esac

step "the overview page is rendered by the server, with real chain data"
PAGE=$(curl -fsS "$WEB/overview")
TREASURY=$(python3 -c "
import json;m=json.load(open('$HERE/deployments/local.json'))['modules']
print([x for x in m if x['kind']=='names'][0]['address'])")
echo "  registry from the manifest: $TREASURY"
case "$PAGE" in
  *"treasury.play"*) note "a name the deploy registered is on the page" ;;
  *) bad "the page carries no registered name - the decoder or the topic is wrong" ;;
esac
case "$PAGE" in
  *"31337"*) note "the chain id is on the page" ;;
  *) bad "the page does not show the chain id" ;;
esac
# Server-rendered, not fetched: the markup must already carry the row before any
# script runs. Checked by asking for the page with no scripting involved at all
# - curl is the reader with JavaScript off.
case "$PAGE" in
  *"<table"*) note "the tables are in the served markup" ;;
  *) bad "the page has no table in its markup" ;;
esac

step "a name redirects with EXACTLY ONE Location header"
# THE ROUTE THIS STEP EXISTS FOR HAD NO TEST AT ALL, which is how it shipped
# emitting two Location headers - the one njs set on headersOut and the empty
# one nginx adds for a redirect status. A browser refuses that outright
# ("Corrupted Content Error"); curl follows it and reports success. So the
# assertion is on the COUNT, not on where the redirect lands: `curl -L` ending
# at the right page is exactly what the broken version also did.
HDRS=$(curl -s -D- -o /dev/null "$WEB/overview/names/treasury.play")
echo "  $(echo "$HDRS" | head -1)"
echo "$HDRS" | grep -i '^location:' | sed 's/^/    /'
check "exactly one Location header" "$(echo "$HDRS" | grep -ci '^location:')" "1"
check "the status is 302" "$(echo "$HDRS" | sed -n '1s/.* \([0-9]*\) .*/\1/p')" "302"
# ...and it points at the address the registry actually resolves, read back
# through the filter rather than written here.
TREASURY=$(post "$RPC" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$(python3 -c "
import json;m=json.load(open('$HERE/deployments/local.json'))['modules']
print([x for x in m if x['kind']=='names'][0]['address'])")\",\"data\":\"0x461a4478$(printf '%064x' 32)$(printf '%064x' 13)$(python3 -c "print('74726561737572792e706c6179'.ljust(64,'0'))")\"},\"latest\"]}"   | jqp "print('0x' + d['result'][-40:])")
check "Location names the resolved address" \
  "$(echo "$HDRS" | grep -i '^location:' | head -1 | tr -d '\r' | sed 's/^[Ll]ocation: *//')" \
  "/address/$TREASURY"
check "an unregistered name is 404" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/overview/names/nobody.registered.this")" "404"

step "the state feed agrees with the node about the height"
# Two independent paths to one fact: the page's own feed, and eth_blockNumber
# through the filter. They are computed by different code and must not disagree.
FEED=$(curl -fsS "$WEB/overview/state.json")
FEED_H=$(echo "$FEED" | jqp "print(d['height'])")
NODE_H=$(post "$RPC" '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' | jqp "print(int(d['result'],16))")
check "state.json height == eth_blockNumber" "$FEED_H" "$NODE_H"
check "state.json is not cached" "$(curl -fsS -D- -o /dev/null "$WEB/overview/state.json" | grep -ci 'cache-control: no-store')" "1"

step "the refusal log is a working instrument"
# THE STEP THAT MAKES THE NEXT ONE TRUSTWORTHY. The measured method set below is
# read out of this log, so a log that silently emits nothing would report "the
# explorer needs no extra methods" - the most dangerous possible answer, and
# indistinguishable from success. anvil_setBalance was refused above; if it is
# not in the log, the measurement is not a measurement.
LOGS=$("${COMPOSE[@]}" logs front 2>&1)
case "$LOGS" in
  *"rpc filter refused: anvil_setBalance"*) note "the refusal from the step above is in the log" ;;
  *) bad "refusals are not reaching the log - every measurement below is void" ;;
esac

step "MEASURING the method set the explorer actually needs"
# Not read off Otterscan's source, which says what it CAN call. The page is
# loaded by a real browser on the compose network, with the allowlist cut back
# to the filter's own default, and whatever it asks for that the default refuses
# is the answer. `--virtual-time-budget` lets the SPA finish its startup fetches
# before the DOM is dumped.
NET="${PROJECT}_default"
MEASURED=""
# THE PAGES AN OPERATOR ACTUALLY OPENS, not just the one the SPA lands on. A
# measurement of `/` alone would report the landing page's methods as "the set
# the explorer needs", and the first person to click a block would find a
# refusal the evidence said could not happen. The transaction hash is taken from
# the chain rather than written here, so the tx page is a real one.
FIRST_TX=$(curl -fsS "$WEB/overview/state.json" | jqp "print(next((b['firstTx'] for b in d['blocks'] if b['firstTx']), ''))")
MEASURE_URLS="/ /block/1 /block/1/txs /tx/$FIRST_TX /address/0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
drive() { # drive - loads every page above in a real browser
  for u in $MEASURE_URLS; do
    docker run --rm --network "$NET" zenika/alpine-chrome:latest \
      --no-sandbox --disable-gpu --disable-dev-shm-usage --dump-dom \
      --virtual-time-budget=20000 "http://front$u" >/dev/null 2>&1 || true
  done
}
if docker image inspect zenika/alpine-chrome:latest >/dev/null 2>&1; then
  echo "  driving: $MEASURE_URLS"
  quietly "restart front with the default allowlist" \
    env RPC_ALLOWED_METHODS="eth_*,net_version,web3_clientVersion" "${COMPOSE[@]}" up -d --force-recreate front
  sleep 3
  SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  drive
  MEASURED=$("${COMPOSE[@]}" logs --since "$SINCE" front 2>&1 \
    | sed -n 's/.*rpc filter refused: //p' | tr ' ' '\n' | sed 's/[^a-zA-Z0-9_].*$//' \
    | grep -v '^$' | sort -u | tr '\n' ' ')
  if [ -n "$MEASURED" ]; then
    echo "  a real browser loading the explorer was refused:"
    for m in $MEASURED; do echo "      $m"; done
  else
    bad "the browser drove the page and nothing was refused - either the browser did not run or the log is not being read"
  fi
  quietly "restore the configured allowlist" "${COMPOSE[@]}" up -d --force-recreate front
  sleep 3
else
  bad "zenika/alpine-chrome is not present; the method set cannot be measured (docker pull zenika/alpine-chrome)"
fi

step "with the configured allowlist, the explorer is refused NOTHING"
# The other direction, and the one that says the configured set is sufficient
# rather than merely large: drive the same page again with compose's own value
# and assert the log stays silent.
if [ -n "$MEASURED" ]; then
  SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  drive
  LEFT=$("${COMPOSE[@]}" logs --since "$SINCE" front 2>&1 | sed -n 's/.*rpc filter refused: //p' | sort -u | tr '\n' ' ')
  check "nothing refused under the configured set" "${LEFT:-(nothing)}" "(nothing)"
fi

step "responses bigger than njs's DEFAULT subrequest buffer arrive intact"
# NJS COLLECTS A SUBREQUEST RESPONSE IN ONE BUFFER, 4 kB by default, and
# overflowing it drops the connection rather than degrading - there is nothing
# to catch in JS. This is set once in the `http` block, so it covers the
# overview's server and the filter's; the checks below exercise BOTH, because a
# setting that only reached one of them would look identical here to one that
# reached neither until a consumer hit it.
#
# LAST, AND THAT IS NOT ARBITRARY. Mining empty blocks pushes the only block
# holding transactions out of the window, and the measurement above takes its
# transaction page from that window - run earlier, this step silently reduced
# the browser's tour to a /tx/ with no hash on the end.
#
# Mined through `docker compose exec`: `anvil_mine` is refused through the front
# (asserted above), so the admin path really is "you have Docker on the host".
quietly "mine 20 blocks via the admin path" \
  "${COMPOSE[@]}" exec -T chain cast rpc anvil_mine 20 --rpc-url http://localhost:8545
NEW_H=$(post "$RPC" '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' | jqp "print(int(d['result'],16))")
[ "$NEW_H" -ge 21 ] && note "the chain advanced to $NEW_H" || bad "the mine did not take (height $NEW_H)"

# THE FILTER PATH. A batch of block fetches is the honest large response: it is
# what any consumer walking a chain sends, and it is far past 4 kB. Asserted on
# the CONTENT, not on the byte count - a dropped connection and a truncated
# reply both fail, and so does a reply that lost an element.
python3 -c "
import json
print(json.dumps([{'jsonrpc':'2.0','id':i,'method':'eth_getBlockByNumber','params':[hex(i),False]} for i in range(1,11)]))" > /tmp/front-batch.json
BATCH_OUT=$(post "$RPC" "$(cat /tmp/front-batch.json)")
echo "  a 10-block batch through the filter came back in $(echo -n "$BATCH_OUT" | wc -c) bytes"
check "every element of the batch has a result" \
  "$(echo "$BATCH_OUT" | jqp "print(sum(1 for x in d if x.get('result')))")" "10"
[ "$(echo -n "$BATCH_OUT" | wc -c)" -gt 4096 ] \
  && note "...and the reply is past 4096 bytes, so this really is the regime that used to drop" \
  || bad "the reply is under 4096 bytes - this check is not exercising the buffer at all"

# THE OVERVIEW PATH, at a size its own batch could not reach before.
BIG=$(curl -fsS "$WEB/overview")
echo "  the overview page is $(echo -n "$BIG" | wc -c) bytes at height $NEW_H"
# THE WINDOW, NOT A COUNT. Counting "/block/" links was wrong twice over: the
# names table links to the block a name was registered in, and the inline poll
# script carries the string as a literal. This asserts what is actually meant.
WANT=${OVERVIEW_BLOCKS:-10}
MISSING=""
N=$NEW_H
while [ "$N" -gt $(( NEW_H - WANT )) ]; do
  case "$BIG" in *"/block/$N\""*) ;; *) MISSING="$MISSING $N" ;; esac
  N=$(( N - 1 ))
done
check "the $WANT most recent blocks are all rendered" "${MISSING:-(none missing)}" "(none missing)"
OUTSIDE=$(( NEW_H - WANT ))
case "$BIG" in
  *"/block/$OUTSIDE\""*) bad "block $OUTSIDE is outside the window and still on the page" ;;
  *) note "block $OUTSIDE, just outside the window, is not on the page" ;;
esac
case "$BIG" in
  *"treasury.play"*) note "...and the names survived the bigger batch" ;;
  *) bad "the page lost its names once the batch grew" ;;
esac

step "verdict"
if [ "$FAIL" = 0 ]; then
  echo "PASS: the front mediates the whole published surface"
else
  echo "FAIL. Checks that failed:$FAILED_CHECKS"
  exit 1
fi
