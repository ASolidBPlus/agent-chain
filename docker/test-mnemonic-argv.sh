#!/bin/sh
# FINDING 25, AS A DETERMINISTIC TEST: the deploy one-shot must never put the
# BIP-39 phrase on a command line.
#
# WHY A STUB AND NOT /proc. The first version of this sampled
# /proc/<pid>/cmdline while cast ran. cast exits in milliseconds, so the sample
# usually found nothing - and the "fixed" case then passed for exactly the same
# reason the control failed. A test that cannot see the defect is not evidence
# of its absence, and one that races is worse than one that is absent: it
# reports a pass.
#
# So this puts a `cast` STUB first on PATH which writes its own argv to a file.
# Nothing races, nothing needs Docker, and it runs anywhere the repo does.
#
# The phrase here is the canonical, publicly-published Foundry/Hardhat test
# phrase - deliberately a WELL-KNOWN value so nobody mistakes it for a secret.
set -eu

# Resolved BEFORE anything changes directory: `$0` is relative when the script is
# invoked by a relative path, and a later `cd` would make it unresolvable.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

PHRASE="test test test test test test test test test test test junk"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

mkdir -p "$WORK/bin"
cat > "$WORK/bin/cast" <<'STUB'
#!/bin/sh
# Records the argv it was called with, then answers like the real thing so the
# script under test carries on.
printf '%s\n' "$*" >> "$ARGV_LOG"
echo "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
STUB
chmod +x "$WORK/bin/cast"

export ARGV_LOG="$WORK/argv.log"
export PATH="$WORK/bin:$PATH"

fail=0

# ── THE CONTROL ──────────────────────────────────────────────────────────────
# The OLD spelling must be SEEN. Without this row the check below passes on a
# build where nothing calls cast at all, and measures nothing.
: > "$ARGV_LOG"
cast wallet private-key --mnemonic "$PHRASE" >/dev/null
if grep -q "junk" "$ARGV_LOG"; then
  echo "ok   control: the old spelling puts the phrase on argv"
else
  echo "FAIL control: the phrase was not observed - this test measures nothing"
  fail=1
fi

# ── THE FIXED SPELLING ───────────────────────────────────────────────────────
: > "$ARGV_LOG"
umask 077
F="$WORK/mnemonic"
printf '%s' "$PHRASE" > "$F"
cast wallet private-key --mnemonic "$F" >/dev/null
if grep -q "junk" "$ARGV_LOG"; then
  echo "FAIL the phrase is on the command line"
  fail=1
else
  echo "ok   the file path is on argv, the phrase is not"
fi

# ── THE SCRIPT ITSELF ────────────────────────────────────────────────────────
# Not just the spelling in isolation: deploy-once.sh as it will actually run.
# `forge` is stubbed too, so nothing needs a chain; the deploy is expected to
# get as far as calling it and no further.
cat > "$WORK/bin/forge" <<'STUB'
#!/bin/sh
printf '%s\n' "forge $*" >> "$ARGV_LOG"
exit 0
STUB
chmod +x "$WORK/bin/forge"

: > "$ARGV_LOG"
mkdir -p "$WORK/deployments"
# `cast` is called BEFORE the script cd's to /contracts, so the missing
# directory stops it after the part this test is about - which is why the
# "did it call cast" row below is the one that says the run got far enough.
ANVIL_MNEMONIC="$PHRASE" \
DEPLOYMENTS_DIR="$WORK/deployments" \
  sh "$SCRIPT_DIR/deploy-once.sh" >"$WORK/out.log" 2>&1 || true

if grep -q "junk" "$ARGV_LOG"; then
  echo "FAIL deploy-once.sh put the phrase on a command line"
  sed -n '1,5p' "$ARGV_LOG"
  fail=1
else
  echo "ok   deploy-once.sh put the phrase on no command line"
fi

# ...and it really did call cast, or the row above proves nothing.
if grep -q "wallet private-key" "$ARGV_LOG"; then
  echo "ok   ...and it did call cast, so that row is about something"
else
  echo "FAIL deploy-once.sh never called cast; the row above is vacuous"
  sed -n '1,10p' "$WORK/out.log"
  fail=1
fi

exit "$fail"
