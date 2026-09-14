#!/usr/bin/env bash
# §8.9. Bring the stack up once per example manifest, and once with none.
#
# WHY THIS EXISTS AS A SCRIPT rather than as a note in a PR body: it is the only
# check that runs the PRODUCTION path. `forge test` and `forge script
# --broadcast` are two execution modes of one file and only the second is what
# chain-deploy runs; an assertion that passes the first and reverts the second
# passed 76/0 and broke every deploy, and nothing but this found it.
#
# `--build` IS LOAD-BEARING. Without it compose reuses whatever chain-svc image
# was built last, so the smoke tests the PREVIOUS service against the CURRENT
# local.json. Measured: four deploys reported exit 0 while chain-svc died on
# every one of them with an error message from code that had already been
# replaced, and the only symptom was an empty health response.
set -uo pipefail
cd "$(dirname "$0")/../.."

env_file=$(mktemp); trap 'rm -f "$env_file"; rm -f deployments/manifest.json' EXIT
umask 077
cat > "$env_file" <<ENV
ANVIL_MNEMONIC=${ANVIL_MNEMONIC:-test test test test test test test test test test test junk}
CHAIN_SVC_TOKEN=$(openssl rand -hex 32)
KEYSTORE_SECRET=$(openssl rand -hex 32)
ENV
token=$(grep '^CHAIN_SVC_TOKEN=' "$env_file" | cut -d= -f2)
dc() { docker compose --env-file "$env_file" -f compose.chain.yml --profile chain "$@"; }

fails=0
ck() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; else echo "  FAIL $1: expected $3, got $2"; fails=$((fails+1)); fi; }

one() {
  local name="$1" manifest="$2" expect_modules="$3"
  echo "── $name"
  dc down -v >/dev/null 2>&1
  rm -f deployments/local.json
  cp "deployments/examples/$manifest" deployments/manifest.json
  dc up -d --build >/dev/null 2>&1

  local health=""
  for _ in $(seq 1 20); do
    health=$(curl -s -m 3 http://127.0.0.1:7000/health 2>/dev/null) && [ -n "$health" ] && break
    sleep 3
  done
  ck "$name: /health lists the manifest's modules" \
     "$(echo "$health" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["modules"]))' 2>/dev/null)" \
     "$expect_modules"
  dc down -v >/dev/null 2>&1
}

one "token-and-names" token-and-names.json "names,token:play"
one "token-only"      token-only.json      "token:play"
one "names-only"      names-only.json      "names"
one "two-tokens"      two-tokens.json      "names,token:gold,token:play"

echo "── no manifest"
dc down -v >/dev/null 2>&1
rm -f deployments/local.json deployments/manifest.json
dc up -d --build >/dev/null 2>&1
ck "refuses to deploy without a manifest" \
   "$(dc logs chain-deploy 2>&1 | grep -c 'a deployment must declare its modules')" "1"
dc down -v >/dev/null 2>&1

echo; [ "$fails" -eq 0 ] && echo "ALL MANIFEST SMOKES PASSED" || echo "$fails FAILED"
exit "$fails"
