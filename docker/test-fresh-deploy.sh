#!/bin/sh
# FINDING 8: when may the one-shot declare a chain fresh?
#
# THE DEFECT. A marker file beside local.json, both under the same bind mount,
# so they shared ONE LIFETIME - wipe the mount, rotate the deployer key, keep
# the chain, and both were absent. The script declared a fresh chain and
# deployed a SECOND SET beside the live one.
#
# Nothing downstream caught it, and that is the part worth understanding: the
# treasury is a CONSTRUCTOR ARGUMENT, so a new key MOVES every derived address.
# No address was occupied, the foreign-code check had nothing to see, and the
# old token kept the supply.
#
# THE MARKER'S OBVIOUS HOME WAS WORSE THAN THE BUG. Moving it into the
# chain-state volume would have meant mounting that volume here - handing the
# container that compiles bind-mounted Solidity write access to anvil.json, the
# entire persisted chain. There is no marker now.
#
# It asks the CHAIN instead, which is the thing the question is about. anvil
# mines ON DEMAND (entrypoint.sh omits --block-time deliberately), so height 0
# means nothing has ever been mined, and `--state` carries the height across
# restarts.
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
# Two subcommands: the key derivation, and the block height this test varies.
case "$1 $2" in
  # STUB_HEIGHT=fail models the real failure - a non-zero exit and no output -
  # rather than an empty string. `${x:-0}` would also have turned an explicitly
  # EMPTY value back into 0, so the "unreadable" row asked for height 0 and
  # measured the fresh-chain path instead. Caught by the row's own assertion.
  "block-number "*|"block-number")
      [ "${STUB_HEIGHT-0}" = "fail" ] && exit 1
      printf '%s\n' "${STUB_HEIGHT-0}" ;;
  *) echo "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" ;;
esac
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

# THE FIXTURE HAS TO SATISFY THE PRECONDITIONS IT IS NOT TESTING. The script
# now checks its deploy script exists before it decides anything, so every row
# below needs one - an empty file is enough, because the `forge` above is a stub
# that never reads it. Without this the rows would all fail at the preflight and
# report nothing about the fresh-chain decision they exist to measure.
mkdir -p "$WORK/script"
: > "$WORK/script/Deploy.s.sol"

# `cd /contracts` is the one thing the stubs cannot stand in for; the script
# reaches it after the decision this test is about, so a missing directory does
# not matter - but it must not be the reason a row passes, which is what the
# "did it decide at all" check below is for.
run() {
  rm -f "$FLAG_LOG"
  ANVIL_MNEMONIC="test test test test test test test test test test test junk" \
  DEPLOYMENTS_DIR="$1" \
  STUB_HEIGHT="$2" \
  CONTRACTS_DIR="$WORK" \
    env -u ALLOW_FRESH_DEPLOY sh "$HERE/deploy-once.sh" >"$WORK/out.log" 2>&1 || true
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

# ── a genuinely fresh chain: no manifest, nothing mined ─────────────────────
D="$WORK/d1"; mkdir -p "$D"
check "no manifest, chain at block 0" "$D" "0" "1"

# ── THE ROW THAT FAILED ON A REAL ANVIL ─────────────────────────────────────
# The bind mount was wiped and the deployer key rotated, but the chain is
# intact. The old logic saw two absences under one mount and called it fresh;
# the chain's own height is the fact that survives a wiped mount.
D="$WORK/d2"; mkdir -p "$D"
check "no manifest, chain at block 42" "$D" "42" ""

# ── the ordinary second run: the manifest is there ──────────────────────────
# Not asked of the chain at all - a manifest means something was deployed.
D="$WORK/d3"; mkdir -p "$D"; printf '{"schema":1}' > "$D/local.json"
check "manifest present, chain used" "$D" "42" ""

# ── an operator may still say so, over a used chain ─────────────────────────
# The script only DECIDES the flag when nobody has. A deliberate setting is the
# authority, and this is the escape hatch the refusal message names.
rm -f "$FLAG_LOG"
D="$WORK/d4"; mkdir -p "$D"
ANVIL_MNEMONIC="test test test test test test test test test test test junk" \
DEPLOYMENTS_DIR="$D" STUB_HEIGHT="42" CONTRACTS_DIR="$WORK" ALLOW_FRESH_DEPLOY=1 \
  sh "$HERE/deploy-once.sh" >"$WORK/out.log" 2>&1 || true
if [ "$(cat "$FLAG_LOG" 2>/dev/null)" = "1" ]; then
  echo "ok   operator set the flag over a used chain -> ALLOW_FRESH_DEPLOY=1"
else
  echo "FAIL an explicitly set flag was not honoured"
  fail=1
fi

# ── and the promotion still happens ─────────────────────────────────────────
D="$WORK/d5"; mkdir -p "$D"
run "$D" "0" >/dev/null || fail=1
if [ -f "$D/local.json" ]; then
  echo "ok   the pending manifest was promoted"
else
  echo "FAIL the pending manifest was not promoted"
  fail=1
fi

# ── an unreadable chain is not a fresh chain ────────────────────────────────
# `cast block-number` failing must refuse rather than fall through to either
# answer: "I could not ask" is not "nothing is there".
rm -f "$FLAG_LOG"
D="$WORK/d6"; mkdir -p "$D"
ANVIL_MNEMONIC="test test test test test test test test test test test junk" \
DEPLOYMENTS_DIR="$D" STUB_HEIGHT="fail" CONTRACTS_DIR="$WORK" \
  env -u ALLOW_FRESH_DEPLOY sh "$HERE/deploy-once.sh" >"$WORK/out.log" 2>&1 && rc=0 || rc=$?
if [ "$rc" != "0" ] && grep -q "refusing to guess" "$WORK/out.log"; then
  echo "ok   an unreadable block height refuses rather than guessing"
else
  echo "FAIL an unreadable block height did not refuse (exit $rc)"
  sed -n '1,4p' "$WORK/out.log"
  fail=1
fi

# ── a deploy script that is not where CONTRACTS_DIR says ───────────────────
# forge answers this with "Error: No such file or directory (os error 2)" and
# no path at all, after the RPC has already connected - so the chain looks
# healthy and the fault looks like any other missing file. The refusal must
# NAME the path it looked at; a refusal that merely refuses leaves the operator
# exactly where forge did.
rm -f "$FLAG_LOG"
D="$WORK/d7"; mkdir -p "$D"
EMPTY="$WORK/not-the-contracts"; mkdir -p "$EMPTY"
ANVIL_MNEMONIC="test test test test test test test test test test test junk" \
DEPLOYMENTS_DIR="$D" STUB_HEIGHT="0" CONTRACTS_DIR="$EMPTY" \
  env -u ALLOW_FRESH_DEPLOY sh "$HERE/deploy-once.sh" >"$WORK/out.log" 2>&1 && rc=0 || rc=$?
if [ "$rc" != "0" ] \
   && grep -q "$EMPTY/script/Deploy.s.sol" "$WORK/out.log" \
   && grep -q "CONTRACTS_DIR" "$WORK/out.log"; then
  echo "ok   a missing deploy script refuses and names the path it looked at"
else
  echo "FAIL a missing deploy script did not name its path (exit $rc)"
  sed -n '1,4p' "$WORK/out.log"
  fail=1
fi
# ...and it refuses BEFORE doing anything: no pending manifest, no promotion.
if [ -f "$D/local.json.pending" ] || [ -f "$D/local.json" ]; then
  echo "FAIL it wrote a manifest despite having no deploy script"
  fail=1
else
  echo "ok   ...and wrote nothing before refusing"
fi

# THE CONTROL FOR THE ROW ABOVE. The same call with the file present must reach
# forge - otherwise "it refused" is just "this invocation never works" and the
# check is about the fixture rather than the guard.
rm -f "$FLAG_LOG"
D="$WORK/d8"; mkdir -p "$D"
mkdir -p "$EMPTY/script"; : > "$EMPTY/script/Deploy.s.sol"
ANVIL_MNEMONIC="test test test test test test test test test test test junk" \
DEPLOYMENTS_DIR="$D" STUB_HEIGHT="0" CONTRACTS_DIR="$EMPTY" \
  env -u ALLOW_FRESH_DEPLOY sh "$HERE/deploy-once.sh" >"$WORK/out.log" 2>&1 || true
if [ -f "$FLAG_LOG" ]; then
  echo "ok   control - with the script present the same call reaches forge"
else
  echo "FAIL control - the call never reaches forge even with the script present"
  sed -n '1,4p' "$WORK/out.log"
  fail=1
fi

exit "$fail"
