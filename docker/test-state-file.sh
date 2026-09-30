#!/bin/sh
# The state-file check in entrypoint.sh, run against fixture files.
#
# THE REAL ENTRYPOINT, NOT A COPY OF ITS LOGIC. `anvil` is replaced by a stub on
# PATH that records it was reached, and ANVIL_STATE_FILE points at a temp file;
# everything else - the scan, the refusal, the backup - is the shipped script.
# A test that re-implemented the check would pass while the entrypoint drifted.
#
# Needs a POSIX shell and core perl, and no Docker, so CI runs it:
#   sh docker/test-state-file.sh
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
fail=0

mkdir -p "$WORK/bin"
cat > "$WORK/bin/anvil" <<'STUB'
#!/bin/sh
# Reaching here means the entrypoint decided the state was fit to start on.
: > "$ANVIL_RAN"
exit 0
STUB
chmod +x "$WORK/bin/anvil"
export PATH="$WORK/bin:$PATH"
export ANVIL_RAN="$WORK/anvil-ran"
MNEMONIC="test test test test test test test test test test test junk"

S="$WORK/anvil.json"
GOOD='{"block":{"number":"0x0","basefee":0},"accounts":{"0xabc":{"nonce":1,"code":"0x"}},"blocks":[]}'

reset() { rm -f "$S" "$S.prev" "$S.prev.tmp" "$ANVIL_RAN" "$WORK/err"; }
run() {
  ANVIL_MNEMONIC="$MNEMONIC" ANVIL_STATE_FILE="$S" \
    sh "$HERE/entrypoint.sh" >/dev/null 2>"$WORK/err" && rc=0 || rc=$?
}
ok()  { echo "ok   $1"; }
bad() { echo "FAIL $1"; sed 's/^/       /' "$WORK/err"; fail=1; }

started()  { [ -f "$ANVIL_RAN" ]; }
said()     { grep -qxF "$1" "$WORK/err"; }
size_of()  { wc -c < "$1" | tr -d ' '; }

# ── starting ─────────────────────────────────────────────────────────────────

reset; run
if [ "$rc" = 0 ] && started && [ ! -e "$S.prev" ]; then ok "no state file: a fresh start, and no backup of nothing"
else bad "no state file (exit $rc)"; fi

reset; printf '%s' "$GOOD" > "$S"; run
if [ "$rc" = 0 ] && started && cmp -s "$S" "$S.prev"; then ok "a complete file starts, and is kept as .prev byte for byte"
else bad "a complete file (exit $rc)"; fi

reset; printf '\n  %s  \n\n' "$GOOD" > "$S"; run
if [ "$rc" = 0 ] && started; then ok "whitespace around a complete file is not damage"
else bad "a whitespace-padded complete file (exit $rc)"; fi

# THE FALSE REFUSAL THIS CHECK WAS ONCE CAPABLE OF. A quantified group over a
# string with many escapes hits perl's recursion limit and reads as
# "unterminated", which would refuse to restart a healthy chain.
reset
perl -e 'print q({"s":"), (q(\") x 200000), q("})' > "$S"; run
if [ "$rc" = 0 ] && started; then ok "a valid file with 200,000 escapes in one string is not refused"
else bad "200,000 escapes (exit $rc)"; fi

# ── refusing ─────────────────────────────────────────────────────────────────

refused() { # refused <label> - exit 2, anvil never reached, and the sentence
  if [ "$rc" = 2 ] && ! started && said "$2"; then ok "$1"; else bad "$1 (exit $rc)"; fi
}

reset; printf '%s' '{"block":{"number":"0x0","basef' > "$S"; run
refused "cut off inside a string" \
  "anvil: state file $S is corrupt (truncated at $(size_of "$S") bytes); move it aside to start fresh - there is no complete $S.prev to restore"

# THE CASE A FIRST-AND-LAST-BYTE CHECK ACCEPTS. Cut straight after an inner
# object closes, the file starts with `{` and ends with `}` - and is still only
# part of a document.
reset; printf '%s' '{"block":{"number":"0x0","basefee":0}' > "$S"; run
refused "cut off just after an inner object closes" \
  "anvil: state file $S is corrupt (truncated at $(size_of "$S") bytes); move it aside to start fresh - there is no complete $S.prev to restore"

reset; : > "$S"; run
refused "an empty file" \
  "anvil: state file $S is corrupt (truncated at 0 bytes); move it aside to start fresh - there is no complete $S.prev to restore"

# ── the backup ───────────────────────────────────────────────────────────────

reset; printf '%s' "$GOOD" > "$S.prev"; printf '%s' '{"blo' > "$S"; run
refused "a complete .prev is offered" \
  "anvil: state file $S is corrupt (truncated at $(size_of "$S") bytes); move it aside to start fresh, or restore $S.prev"

reset; printf '%s' '{"blo' > "$S.prev"; printf '%s' '{"bl' > "$S"; run
refused "a .prev that is itself cut off is not offered" \
  "anvil: state file $S is corrupt (truncated at $(size_of "$S") bytes); move it aside to start fresh - there is no complete $S.prev to restore"

# THE PROPERTY THE BACKUP EXISTS FOR. A damaged file must never replace a good
# .prev: the refusal happens before the copy, so the last good state survives
# exactly the event it is kept for.
reset; printf '%s' "$GOOD" > "$S.prev"; printf '%s' '{"block":{"number":"0x0"}' > "$S"; run
if [ "$rc" = 2 ] && [ "$(cat "$S.prev")" = "$GOOD" ]; then ok "a refused file leaves the good .prev exactly as it was"
else bad "the good .prev was disturbed by a refused file (exit $rc)"; fi

# Nothing half-written is left behind by a successful rotation.
reset; printf '%s' "$GOOD" > "$S"; run
if [ ! -e "$S.prev.tmp" ]; then ok "a rotation leaves no temporary file behind"
else bad "a .prev.tmp was left behind"; fi

exit "$fail"
