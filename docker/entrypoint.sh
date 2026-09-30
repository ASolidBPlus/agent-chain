#!/bin/sh
set -eu

# ANVIL_MNEMONIC derives account 0, which is the deployer AND the treasury key
# for the whole game (spec S2). It is a per-deployment secret from the hub .env
# (spec S10) and must never acquire a default here: a defaulted phrase means
# every deployment shares one treasury key, and the "secret" is a constant.
if [ -z "${ANVIL_MNEMONIC:-}" ]; then
  echo "anvil: ANVIL_MNEMONIC is unset - refusing to start rather than derive the treasury key from a default" >&2
  echo "anvil: generate one with: cast wallet new-mnemonic" >&2
  exit 1
fi

# BIP-39 phrases are 12 or 24 words. Checked here because a truncated phrase -
# the shape a .env quoting mistake produces - otherwise reaches anvil as an
# invalid-checksum error that reads like a bug in this script.
words=$(printf '%s' "$ANVIL_MNEMONIC" | wc -w)
if [ "$words" -ne 12 ] && [ "$words" -ne 24 ]; then
  echo "anvil: ANVIL_MNEMONIC must be a 12- or 24-word BIP-39 phrase; got $words words" >&2
  echo "anvil: if it is quoted correctly in .env, generate a new one with: cast wallet new-mnemonic" >&2
  exit 1
fi

STATE_FILE="${ANVIL_STATE_FILE:-/state/anvil.json}"

# THE STATE FILE IS CHECKED BEFORE ANVIL SEES IT, and the reason is the message.
#
# An unclean host shutdown can leave the file cut off mid-write. anvil already
# refuses such a file - measured: exit 2 on a truncated file and on a malformed
# one - so it never starts silently on a broken state. What it prints is
# `invalid value '/state/anvil.json' for '--state <PATH>': failed to parse json
# file ... For more information, try '--help'`, which reads as a mistake in the
# command line, and the node then restart-loops looking misconfigured rather
# than damaged. This says what is wrong and what to do about it.
#
# A COMPLETENESS SCAN, NOT A FULL PARSE, and that is measured rather than
# preferred. anvil writes this file itself, with a correct serializer, so the one
# way it can be broken when this runs is a write that did not finish - and for a
# single top-level object that is exactly "a string left open, or the brackets
# not back to zero". For every file anvil can produce, the scan and a full parse
# give the same answer, and "truncated at N bytes" below is then always true;
# anything the scan passes that is still malformed is refused by anvil as before.
#
# It is also bounded. Perl's JSON::PP, the only full parser in this image, took
# 25-85 s on a 56 MB file depending on host load, against about a second for the
# scan, and the healthcheck allows roughly 55 s - so a full parse would let what
# else the host is doing decide whether a large chain comes up.
#
# NOT the first and last byte alone: a file cut straight after an inner object
# closes starts with `{` and ends with `}`. Measured on a real 40-transaction
# state file, that test accepts 381 of its 165,490 truncation points; this scan
# accepts none. Accepting one would copy it over the good .prev below.
#
# Strings are scanned WITHOUT a quantified group on purpose. `(?:a|b)*` over a
# string with many escapes hits perl's 65534 recursion limit and fails as though
# the string were unterminated - measured on a valid file, which would refuse to
# restart a healthy chain. The loop below has no such limit.
# Exit status says what was found: 0 a complete document, 1 one that ends
# mid-document, 3 one containing a raw NUL byte, 2 a file that cannot be read.
#
# THE NUL CHECK IS SEPARATE, AND IT CLOSES A REAL HOLE. anvil's serializer
# escapes every control character, so a raw NUL can only come from damage - and
# it comes from a common one: a filesystem that commits a file's new size before
# its data leaves the tail reading as zeros after a crash. The scan skips NUL
# like any other byte outside a string, so a complete document followed by zeros
# passed it. Measured on a real state file: the scan accepted it and anvil
# refused it - and in between, this entrypoint would have copied it over the
# good .prev.
state_status() {
  perl -e '
    my $f = shift; open my $h, "<", $f or exit 2;
    local $/; my $s = <$h>; $s = "" unless defined $s;
    exit 3 if index($s, "\0") >= 0;
    my ($d, $opened) = (0, 0);
    pos($s) = 0;
    while (pos($s) < length $s) {
      if ($s =~ /\G"/gc) {
        while (1) {
          $s =~ /\G[^"\\]*+/gc;
          if    ($s =~ /\G"/gc)    { last }
          elsif ($s =~ /\G\\./gcs) { next }
          else                     { exit 1 }
        }
      }
      elsif ($s =~ /\G[{\[]/gc)        { $d++; $opened = 1 }
      elsif ($s =~ /\G[}\]]/gc)        { $d--; exit 1 if $d < 0 }
      elsif ($s =~ /\G[^"{}\[\]]++/gc) { }
      else                             { exit 1 }
    }
    exit(($d == 0 && $opened) ? 0 : 1);
  ' "$1"
}

if [ -e "$STATE_FILE" ]; then
  st=0; state_status "$STATE_FILE" || st=$?
  if [ "$st" != 0 ]; then
    size=$(wc -c < "$STATE_FILE" 2>/dev/null | tr -d ' ')
    # WHAT IS WRONG, IN WORDS THAT ARE TRUE OF THIS FILE. "Truncated at N bytes"
    # was not: a file padded with zeros is N bytes long and its document ends
    # well before that. The size is stated as the file's, and the fault as what
    # the scan found.
    case "$st" in
      3) what="is damaged (it is ${size:-an unknown number of} bytes and contains zero bytes where data should be)" ;;
      2) what="cannot be read" ;;
      *) what="is incomplete (it is ${size:-an unknown number of} bytes and ends mid-document)" ;;
    esac
    # The backup is OFFERED only if it is itself complete. Pointing an operator
    # at a .prev that is also damaged sends them straight into a second refusal.
    pst=1; [ -e "$STATE_FILE.prev" ] && { state_status "$STATE_FILE.prev" && pst=0 || true; }
    if [ "$pst" = 0 ]; then
      echo "anvil: state file $STATE_FILE $what; move it aside to start fresh, or restore $STATE_FILE.prev" >&2
    else
      echo "anvil: state file $STATE_FILE $what; move it aside to start fresh - there is no complete $STATE_FILE.prev to restore" >&2
    fi
    # 2, the code anvil itself uses for this file, so anything already reading
    # the exit status does not see the meaning of a refusal change. Never an
    # automatic restore and never an empty start: which state to keep is the
    # operator's decision, and both of those would make it for them.
    exit 2
  fi

  # THE LAST GOOD FILE, KEPT BEFORE ANVIL CAN OVERWRITE IT. anvil dumps to this
  # path every few seconds and on shutdown, so an interrupted dump damages the
  # only copy there is. Taken only from a file that just passed the scan, so a
  # damaged file never replaces a good backup.
  #
  # Copied, synced, then RENAMED into place: a rename within one filesystem is
  # atomic, so a crash part-way through leaves the previous .prev whole rather
  # than a half-written one - a backup that can itself be truncated is not one.
  #
  # What restoring it costs: .prev is the state as of this boot, so a restore
  # loses whatever happened between this boot and the failure.
  #
  # A FAILED REFRESH WARNS AND STARTS ANYWAY. The backup is a safety extra; a
  # read-only /state or a full disk must not turn it into the reason a healthy
  # chain stops booting, which is what `set -e` made of a failing cp. On any
  # failure the partial temp file is removed - a full disk otherwise leaves one
  # behind - the existing .prev is left exactly as it was, and anvil starts.
  if err=$( { cp "$STATE_FILE" "$STATE_FILE.prev.tmp" \
                && sync "$STATE_FILE.prev.tmp" \
                && mv -f "$STATE_FILE.prev.tmp" "$STATE_FILE.prev"; } 2>&1 ); then
    :
  else
    rm -f "$STATE_FILE.prev.tmp" 2>/dev/null || true
    reason=$(printf '%s' "$err" | head -n 1)
    echo "anvil: could not refresh $STATE_FILE.prev (${reason:-unknown error}); starting without a fresh backup" >&2
  fi
fi

# FINDING 9: ONE ORIGIN, NOT ALL OF THEM.
#
# anvil's default is `--allow-origin *`, which sets
# `Access-Control-Allow-Origin: *` on the JSON-RPC endpoint - so ANY page an
# operator's browser loads could make RPC calls to this node. When this was
# written the node was bound to 127.0.0.1 by compose, and that is exactly the
# reach a browser has: a same-machine origin is not a barrier to it. On a chain
# where the treasury key signs, "any web page may call eth_sendTransaction" is
# worth one flag.
#
# NO LONGER LOAD-BEARING, AND KEPT ANYWAY. This node has no host binding as of
# the front service: nothing outside the container network can reach it, so no
# browser can send it a cross-origin request and this header decides nothing.
# The flag stays as defence in depth, for the deployment that republishes the
# port against advice.
#
# THE DEFAULT NAMES AN ORIGIN THAT CANNOT EXIST. `.invalid` is reserved by
# RFC 2606 and never resolves, so no page can ever carry this origin and the
# header can never match one.
#
# DELIBERATELY NOT THE FRONT'S ORIGIN, which is the trap this default exists to
# avoid: pointing it at the front would re-arm browser access to the node the
# moment anyone republished the port, and the front's whole purpose is that
# requests arrive THROUGH it. A deployment that has been setting this to an
# explorer origin should stop - the explorer now calls the front, same-origin,
# and needs nothing from this flag.
#
# It was `http://127.0.0.1:5100` - the explorer's published origin, measured at
# v0.9.0 when the explorer was published and the node was on loopback beside it.
# Both halves of that arrangement are gone.
ALLOW_ORIGIN="${ANVIL_ALLOW_ORIGIN:-https://node-rpc.invalid}"

# --state both LOADS the file when it exists and DUMPS to it, so there is no
# separate --load-state branch to write; a cold start with no file just begins
# empty. --state-interval 5 leaves up to 5s of writes in memory only: anvil
# dumps on a clean SIGTERM (docker stop, compose restart), but `docker kill`
# can lose that window. Spec S2 documents and accepts this for a classroom.
#
# NOTE: spec S2 originally listed `--block-time 0` for instant mining. Anvil
# 1.8.1 rejects it ("Duration must be greater than 0") - instant mining is what
# anvil does by DEFAULT when --block-time is omitted, which is why it is omitted
# here. ruled; S2 corrected.
# -q because anvil's startup banner prints the MNEMONIC and every derived
# PRIVATE KEY to stdout, and account 0 is the treasury - the one key that can
# mint. `docker logs` is not a secret store: it is readable by anyone on the
# host with docker access, shipped wholesale by any log collector, and kept
# after the container is gone. Measured on this image: without -q the banner
# matches /private key|mnemonic|0x[0-9a-f]{64}/ three times; with it, zero, and
# the node still serves (the S2 healthcheck is `cast block-number`, not a log
# scrape). The cost is losing the "Listening on" line, which is the right trade.
exec anvil \
  -q \
  --host 0.0.0.0 \
  --port 8545 \
  --chain-id 31337 \
  --gas-price 0 \
  --base-fee 0 \
  --accounts 1 \
  --balance 1000000 \
  --mnemonic "$ANVIL_MNEMONIC" \
  --state "$STATE_FILE" \
  --state-interval 5 \
  --allow-origin "$ALLOW_ORIGIN" \
  "$@"
