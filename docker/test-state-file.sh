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
# Write permission first: a row makes a directory read-only, and a test that dies
# inside it would otherwise leave a temp tree nothing can remove.
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT INT TERM
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

mkdir -p "$WORK/state"
S="$WORK/state/anvil.json"
GOOD='{"block":{"number":"0x0","basefee":0},"accounts":{"0xabc":{"nonce":1,"code":"0x"}},"blocks":[]}'
# .prev is compared BYTE FOR BYTE against this file, never through `$(cat ...)`:
# a shell variable cannot hold a NUL, so dash drops them, and a .prev that had
# been replaced by the good document followed by zeros compared EQUAL to the
# good document. The row meant to catch exactly that passed with the NUL check
# removed; this is the fix for that row, not a style choice.
printf '%s' "$GOOD" > "$WORK/good.ref"
prev_is_good() { cmp -s "$S.prev" "$WORK/good.ref"; }

reset() { chmod 0755 "$WORK/state"; rm -f "$S" "$S.prev" "$S.prev.tmp" "$ANVIL_RAN" "$WORK/err"; }
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
  "anvil: state file $S is incomplete (it is $(size_of "$S") bytes and ends mid-document); move it aside to start fresh - there is no complete $S.prev to restore"

# THE CASE A FIRST-AND-LAST-BYTE CHECK ACCEPTS. Cut straight after an inner
# object closes, the file starts with `{` and ends with `}` - and is still only
# part of a document.
reset; printf '%s' '{"block":{"number":"0x0","basefee":0}' > "$S"; run
refused "cut off just after an inner object closes" \
  "anvil: state file $S is incomplete (it is $(size_of "$S") bytes and ends mid-document); move it aside to start fresh - there is no complete $S.prev to restore"

reset; : > "$S"; run
refused "an empty file" \
  "anvil: state file $S is incomplete (it is 0 bytes and ends mid-document); move it aside to start fresh - there is no complete $S.prev to restore"

# ── the backup ───────────────────────────────────────────────────────────────

reset; printf '%s' "$GOOD" > "$S.prev"; printf '%s' '{"blo' > "$S"; run
refused "a complete .prev is offered" \
  "anvil: state file $S is incomplete (it is $(size_of "$S") bytes and ends mid-document); move it aside to start fresh, or restore $S.prev"

reset; printf '%s' '{"blo' > "$S.prev"; printf '%s' '{"bl' > "$S"; run
refused "a .prev that is itself cut off is not offered" \
  "anvil: state file $S is incomplete (it is $(size_of "$S") bytes and ends mid-document); move it aside to start fresh - there is no complete $S.prev to restore"

# THE PROPERTY THE BACKUP EXISTS FOR. A damaged file must never replace a good
# .prev: the refusal happens before the copy, so the last good state survives
# exactly the event it is kept for.
reset; printf '%s' "$GOOD" > "$S.prev"; printf '%s' '{"block":{"number":"0x0"}' > "$S"; run
if [ "$rc" = 2 ] && prev_is_good; then ok "a refused file leaves the good .prev exactly as it was"
else bad "the good .prev was disturbed by a refused file (exit $rc)"; fi

# Nothing half-written is left behind by a successful rotation.
reset; printf '%s' "$GOOD" > "$S"; run
if [ ! -e "$S.prev.tmp" ]; then ok "a rotation leaves no temporary file behind"
else bad "a .prev.tmp was left behind"; fi

# ── zero bytes: the crash that commits a file's size before its data ─────────

# A COMPLETE DOCUMENT FOLLOWED BY ZEROS. The scan used to skip NUL like any byte
# outside a string and accept this; anvil refuses it. In between, the backup
# would have been refreshed from it - replacing the good .prev with a file anvil
# cannot load. Measured on a real state file before this row existed.
reset; printf '%s' "$GOOD" > "$S.prev"; { printf '%s' "$GOOD"; head -c 4096 /dev/zero; } > "$S"; run
refused "a complete document followed by zero bytes" \
  "anvil: state file $S is damaged (it is $(size_of "$S") bytes and contains zero bytes where data should be); move it aside to start fresh, or restore $S.prev"
if prev_is_good; then ok "...and the good .prev survived it"
else bad "the good .prev was replaced by a zero-padded file"; fi

reset; { printf '%s' '{"block":{"number":"0x0","basefee'; head -c 4096 /dev/zero; } > "$S"; run
refused "a cut-off document followed by zero bytes" \
  "anvil: state file $S is damaged (it is $(size_of "$S") bytes and contains zero bytes where data should be); move it aside to start fresh - there is no complete $S.prev to restore"

# ── refreshing the backup must never stop a healthy chain ────────────────────

warned() { grep -q "^anvil: could not refresh $S.prev (.*); starting without a fresh backup$" "$WORK/err"; }

# A READ-ONLY /state. The row checks its own premise first: chmod does not bind
# root, and a directory this user can still write to would make the row pass
# while testing nothing.
reset; printf '%s' "$GOOD" > "$S"; printf '%s' "$GOOD" > "$S.prev"; chmod 0555 "$WORK/state"
# `touch`, not `: >`. `:` is a special builtin, and a failed redirection on a
# special builtin ends the whole shell - inside an `if`, and past `2>/dev/null` -
# so the probe for "is this read-only" killed the test the moment the answer
# was yes.
if touch "$WORK/state/.probe" 2>/dev/null; then
  rm -f "$WORK/state/.probe"; bad "read-only /state: this user can still write the directory, so the row would be vacuous"
else
  run
  if [ "$rc" = 0 ] && started && warned && prev_is_good; then
    ok "a read-only /state starts anvil, warns, and leaves .prev as it was"
  else bad "a read-only /state (exit $rc)"; fi
fi
chmod 0755 "$WORK/state"

# A DISK THAT FILLS MID-COPY: part of the file written, then the write fails.
# A real full filesystem needs root to create; this `cp` reproduces what one
# leaves behind, which is the thing the cleanup exists for.
reset; printf '%s' "$GOOD" > "$S"; printf '%s' '{"old":"backup"}' > "$S.prev"
mkdir -p "$WORK/fullbin"
cat > "$WORK/fullbin/cp" <<'STUB'
#!/bin/sh
head -c 10 "$1" > "$2"
echo "cp: error writing '$2': No space left on device" >&2
exit 1
STUB
chmod +x "$WORK/fullbin/cp"
PATH="$WORK/fullbin:$PATH" run
if [ "$rc" = 0 ] && started && warned && [ ! -e "$S.prev.tmp" ] && [ "$(cat "$S.prev")" = '{"old":"backup"}' ]; then
  ok "a full disk starts anvil, warns, removes the partial temp file, and leaves .prev as it was"
else bad "a full disk (exit $rc; temp file left: $([ -e "$S.prev.tmp" ] && echo yes || echo no))"; fi
if said "anvil: could not refresh $S.prev (cp: error writing '$S.prev.tmp': No space left on device); starting without a fresh backup"; then
  ok "...and the warning carries the reason"
else bad "the warning does not carry cp's reason"; fi

exit "$fail"
