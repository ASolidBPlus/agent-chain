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
CONTRACTS="${CONTRACTS_DIR:-/contracts}"
RPC="${RPC_URL:-http://chain:8545}"
LOCAL="$DEPLOYMENTS/local.json"
PENDING="$LOCAL.pending"

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

# WHEN MAY THIS DECLARE A FRESH CHAIN?
#
# It used to ask the filesystem: no marker file and no local.json. Both lived
# under the same bind mount, so they shared ONE LIFETIME - wipe the mount,
# rotate the deployer key, keep the chain, and both were absent. The script
# declared a fresh chain and deployed a SECOND SET beside the live one. Nothing
# downstream caught it: the treasury is a CONSTRUCTOR ARGUMENT, so a new key
# MOVES every derived address, nothing was occupied, and the old token kept the
# supply. Two absences that always vanish together cannot be two independent
# questions.
#
# THE MARKER'S OBVIOUS HOME WAS WORSE THAN THE BUG. Putting it in the chain-state
# volume would have meant mounting that volume here - handing the container that
# compiles bind-mounted Solidity write access to anvil.json, the entire
# persisted chain.
#
# So ask the CHAIN, which is the thing the question is actually about. anvil
# mines ON DEMAND - entrypoint.sh omits --block-time deliberately - so height 0
# means nothing has ever been mined here, and `--state` carries the height
# across restarts. Any block at all means the chain has been used, whether or
# not this deployment is what used it.
#
# Conservative in the one direction that matters: a chain someone merely sent a
# transaction to refuses, and the operator says so with the flag.
if [ -n "${ALLOW_FRESH_DEPLOY:-}" ]; then
  # An operator who set it deliberately is the authority. This script only ever
  # DECIDES the flag when nobody has.
  ALLOW="$ALLOW_FRESH_DEPLOY"
  echo "deploy: ALLOW_FRESH_DEPLOY=$ALLOW was set by the caller"
elif [ -f "$LOCAL" ]; then
  ALLOW=""
else
  height=$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo "")
  if [ -z "$height" ]; then
    echo "deploy: could not read the block height from $RPC - refusing to guess" >&2
    exit 1
  fi
  if [ "$height" = "0" ]; then
    echo "deploy: no $LOCAL and the chain is at block 0 - nothing here to orphan"
    ALLOW=1
  else
    echo "deploy: no $LOCAL, but the chain is at block $height - it has been used."
    echo "deploy: the deploy will refuse; restore the manifest, or set ALLOW_FRESH_DEPLOY=1 if this chain really is disposable."
    ALLOW=""
  fi
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
# Overridable so the script can be run outside the container - which was one of
# the reasons for lifting it out of the compose block, and is what its tests do.
cd "$CONTRACTS"

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
  # AN EXPLICIT MODE, BECAUSE THE UMASK ABOVE IS NOT ABOUT THIS FILE.
  #
  # `umask 077` is set for the mnemonic file - the one real secret this script
  # touches - but a umask is process-wide, so `forge` inherited it and wrote the
  # manifest 0600 owned by the deploying uid. Nothing noticed while the only
  # reader ran as root with capabilities. The front does not: it drops
  # CAP_DAC_OVERRIDE and serves as `nginx`, so the manifest was unreadable and
  # its overview reported "this deployment has no name registry" about a
  # registry that was deployed and working.
  #
  # The manifest holds deployed contract ADDRESSES, which anyone who can reach
  # the chain can read off it - there is nothing here to withhold, and the 0600
  # was collateral rather than a decision. Set deliberately so the next reader
  # does not have to rediscover this.
  chmod 0644 "$LOCAL"
  echo "deploy: promoted $PENDING to $LOCAL"
else
  echo "deploy: nothing to promote; $LOCAL is up to date"
fi
