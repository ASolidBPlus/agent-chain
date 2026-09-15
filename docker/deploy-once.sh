#!/bin/sh
# The deploy one-shot: derive the treasury key, run the script, and PROMOTE the
# manifest only if the broadcast actually succeeded.
#
# Lifted out of compose.chain.yml's inline `command:` rather than grown there.
# Three reasons, and the third is the one that matters:
#
#   1. Inline YAML shell is unreviewable at this length - `$$` escaping, no
#      syntax checking, and a diff that shows the whole block as one line.
#   2. It can be run by hand against a live chain, which is how anyone will
#      debug a failed promotion.
#   3. THE ANVIL ENTRYPOINT IS A DIFFERENT FILE. docker/entrypoint.sh is
#      anvil's, not this; keeping the deploy one-shot out of it means an edit
#      here and an edit there cannot touch the same lines.
set -eu

DEPLOYMENTS="${DEPLOYMENTS_DIR:-/deployments}"
RPC="${RPC_URL:-http://chain:8545}"
LOCAL="$DEPLOYMENTS/local.json"
PENDING="$LOCAL.pending"
# Written on the first successful promotion and never removed. Its ABSENCE is
# what "this volume has never held a deployment" means - a question the script
# cannot answer from the chain, and used to guess at from the deployer's nonce.
MARKER="$DEPLOYMENTS/.deployed-once"

if [ -z "${ANVIL_MNEMONIC:-}" ]; then
  echo "deploy: ANVIL_MNEMONIC is unset - it derives the treasury key" >&2
  exit 1
fi

# A STALE .pending IS DELETED BEFORE EVERY RUN, not after.
#
# It is the output of a run that wrote a manifest and then failed - a reverted
# broadcast, a killed container, a full disk. Left in place, the NEXT run's
# promotion would move a manifest describing a deployment that never happened
# onto a chain that has a different one, or none. Deleting it before means a
# promotion can only ever move a file this run wrote.
rm -f "$PENDING"

# THE FLAG IS SET ONLY ON A VOLUME THAT HAS NEVER HELD A DEPLOYMENT, and only
# when there is no manifest to restore. Both conditions, because they answer
# different questions: the marker says "nothing was ever deployed from here",
# and the missing local.json says "there is nothing to read". A volume that has
# deployed before and lost its manifest is exactly the case the refusal exists
# for - the operator restores the file or says the chain is disposable, and
# neither is this script's call to make.
ALLOW=""
if [ ! -f "$MARKER" ] && [ ! -f "$LOCAL" ]; then
  echo "deploy: no $MARKER and no $LOCAL - treating this as a fresh volume"
  ALLOW=1
fi

# THE PHRASE NEVER REACHES ARGV (finding 25).
#
# `cast wallet private-key --mnemonic "$ANVIL_MNEMONIC"` puts the treasury's
# BIP-39 phrase in the process command line, where `docker top`, `ps` and
# /proc/<pid>/cmdline all show it to anyone on the host - and a container's
# cmdline is readable without entering the container at all. That is the one
# secret in this system that can mint.
#
# `--mnemonic-stdin` DOES NOT EXIST in the pinned cast (v1.8.1) - checked, the
# flag list has --mnemonic, --mnemonic-passphrase, --mnemonic-derivation-path
# and --mnemonic-index and nothing that reads the phrase from a pipe. What
# --mnemonic DOES accept is "the mnemonic phrase OR mnemonic file at the
# specified path", so the phrase goes to a file and the PATH goes on argv.
# Verified: both spellings derive the same key.
#
# The file is created with a 077 umask in the container's own filesystem and
# removed on every exit path, including a failed deploy.
umask 077
MNEMONIC_FILE=$(mktemp)
cleanup() { rm -f "$MNEMONIC_FILE"; }
trap cleanup EXIT INT TERM
printf '%s' "$ANVIL_MNEMONIC" > "$MNEMONIC_FILE"

# NON-EMPTY, CHECKED. If the file is absent or empty, cast falls back to reading
# the argument AS A PHRASE and reports "the word /tmp/tmp.XXXX is invalid" - an
# error about a path that looks like an error about a mnemonic, which sends
# whoever reads it to the wrong place entirely.
if [ ! -s "$MNEMONIC_FILE" ]; then
  echo "deploy: could not write the mnemonic to $MNEMONIC_FILE (is the filesystem writable?)" >&2
  exit 1
fi

KEY=$(cast wallet private-key --mnemonic "$MNEMONIC_FILE")
cd /contracts

# `set -e` would exit here on a non-zero status, which is the wrong shape: a
# failed deploy must still reach the cleanup below rather than leave a .pending
# behind for the next run to find. So the status is captured deliberately.
status=0
DEPLOYER_PRIVATE_KEY="$KEY" \
DEPLOYMENTS_DIR="$DEPLOYMENTS" \
ALLOW_FRESH_DEPLOY="$ALLOW" \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast || status=$?

if [ "$status" -ne 0 ]; then
  rm -f "$PENDING"
  echo "deploy: the script failed (exit $status); $LOCAL is unchanged" >&2
  exit "$status"
fi

# PROMOTION IS THE LAST THING AND IT IS CONDITIONAL ON SUCCESS.
#
# The script writes .pending, never local.json. So a run WITHOUT --broadcast -
# a simulation, which forge will happily do and which produces addresses that
# were never mined - cannot touch the manifest the rest of the system reads.
# Before this, a simulated run wrote local.json and every service afterwards
# believed in contracts that do not exist.
#
# No .pending after a successful run means the script took its skip path and
# had nothing to write, which is not an error.
if [ -f "$PENDING" ]; then
  mv "$PENDING" "$LOCAL"
  : > "$MARKER"
  echo "deploy: promoted $PENDING to $LOCAL"
else
  echo "deploy: nothing to promote; $LOCAL is up to date"
  # A deployment that was already current still proves the volume has held one.
  [ -f "$LOCAL" ] && : > "$MARKER"
fi
