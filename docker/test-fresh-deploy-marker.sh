#!/bin/sh
# FINDING 8, RESIDUAL A: when may the one-shot declare a chain fresh?
#
# THE DEFECT. The marker and local.json both lived under ./deployments, so they
# shared one lifetime. Wipe the bind mount, rotate the deployer key, keep the
# chain volume - both absent, so the script declared a fresh chain and deployed
# a SECOND SET beside the live one.
#
# Nothing downstream caught it either, and that is the part worth understanding:
# the treasury is a CONSTRUCTOR ARGUMENT, so a new key MOVES every derived
# address. No address was occupied, the foreign-code check had nothing to see,
# and the old token kept the supply.
#
# TWO ABSENCES THAT ALWAYS VANISH TOGETHER CANNOT BE TWO INDEPENDENT QUESTIONS.
# The marker now lives in the chain-state volume, which is the only thing that
# can answer "has this CHAIN held a deployment".
#
# Stubs, so this needs no Docker and no chain: `cast` and `forge` are replaced,
# and the assertion is on the ALLOW_FRESH_DEPLOY value the script passes.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
fail=0

mkdir -p "$WORK/bin"
cat > "$WORK/bin/cast" <<'STUB'
#!/bin/sh
echo "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
STUB
# Records the flag the script decided on, and writes the pending manifest the
# real script would, so the promotion path runs too.
cat > "$WORK/bin/forge" <<'STUB'
#!/bin/sh
printf '%s\n' "${ALLOW_FRESH_DEPLOY-<unset>}" > "$FLAG_LOG"
printf '{"schema":1}' > "$DEPLOYMENTS_DIR/local.json.pending"
exit 0
STUB
chmod +x "$WORK/bin/cast" "$WORK/bin/forge"
export PATH="$WORK/bin:$PATH"
export FLAG_LOG="$WORK/flag"

# `cd /contracts` is the one thing the stubs cannot stand in for; the script
# reaches it after the decision this test is about, so a missing directory does
# not matter - but it must not be the reason a row passes, which is what the
# "did it decide at all" check below is for.
run() {
  rm -f "$FLAG_LOG"
  ANVIL_MNEMONIC="test test test test test test test test test test test junk" \
  DEPLOYMENTS_DIR="$1" \
  MARKER_FILE="$2" \
  CONTRACTS_DIR="$WORK" \
    sh "$HERE/deploy-once.sh" >"$WORK/out.log" 2>&1 || true
  if [ ! -f "$FLAG_LOG" ]; then
    sed -n '1,4p' "$WORK/out.log" >&2
    return 1
  fi
  cat "$FLAG_LOG"
}

check() {
  # The diagnostic from `run` must reach the terminal, not be swallowed into
  # `got` - the first version captured it and printed nothing at all, so four
  # rows failed silently and only the two that do not use `check` said anything.
  if ! got=$(run "$2" "$3"); then
    echo "FAIL $1 -> the script never reached forge"
    fail=1
    return
  fi
  if [ "$got" = "$4" ]; then
    echo "ok   $1 -> ALLOW_FRESH_DEPLOY=$got"
  else
    echo "FAIL $1 -> ALLOW_FRESH_DEPLOY=$got, wanted $4"
    fail=1
  fi
}

# ── the genuinely fresh chain: nothing anywhere ──────────────────────────────
D="$WORK/d1"; M="$WORK/state1/.deployed-once"; mkdir -p "$D"
check "fresh chain, fresh manifest dir" "$D" "$M" "1"

# ── THE ROW THAT FAILED ON A REAL ANVIL ──────────────────────────────────────
# The chain has held a deployment (its volume carries the marker) and the bind
# mount has been wiped, so local.json is gone. The old code saw two absences and
# declared a fresh chain; the marker in the chain's own volume is the one that
# survives.
D="$WORK/d2"; M="$WORK/state2/.deployed-once"; mkdir -p "$D" "$WORK/state2"; : > "$M"
check "chain kept, manifest wiped" "$D" "$M" ""

# ── the ordinary second run: both present ────────────────────────────────────
D="$WORK/d3"; M="$WORK/state3/.deployed-once"; mkdir -p "$D" "$WORK/state3"
: > "$M"; printf '{"schema":1}' > "$D/local.json"
check "chain kept, manifest kept" "$D" "$M" ""

# ── manifest present, marker absent: a pre-marker deployment ─────────────────
# Not fresh: there is a manifest, so something was deployed. The flag is for
# having nothing to orphan, and a manifest is something.
D="$WORK/d4"; M="$WORK/state4/.deployed-once"; mkdir -p "$D"
printf '{"schema":1}' > "$D/local.json"
check "manifest kept, marker absent" "$D" "$M" ""

# ── and the promotion writes the marker where it can survive ─────────────────
D="$WORK/d5"; M="$WORK/state5/.deployed-once"; mkdir -p "$D"
run "$D" "$M" >/dev/null || fail=1
if [ -f "$M" ]; then
  echo "ok   the promotion wrote the marker into the chain-state path"
else
  echo "FAIL the promotion did not write $M"
  fail=1
fi
if [ -f "$D/local.json" ]; then
  echo "ok   ...and promoted the pending manifest"
else
  echo "FAIL the pending manifest was not promoted"
  fail=1
fi

exit "$fail"
