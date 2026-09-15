#!/bin/sh
# Regression test for contracts.yml's ffi guard.
#
# THE GUARD IT TESTS replaced `FOUNDRY_FFI: false` in the job env, which is
# INERT: `--ffi` is enable-only and the env var is its binding, so there is no
# value of it that turns the feature off. Measured by the security reviewer with
# `ffi = true` inserted in [profile.default] - forge ran the shelled-out command
# on the runner with the variable set in every spelling.
#
# A control that cannot fail closed is worse than none, because it reads as a
# guarantee. What CAN be asserted is that the config does not enable it, and
# this is the test for that assertion.
set -eu

CONFIG="$(cd "$(dirname "$0")/../../contracts" && pwd)/foundry.toml"

# The guard, character for character as contracts.yml runs it. Duplicated rather
# than sourced because the workflow cannot source a file from a step, and two
# spellings of one pattern is exactly the drift this repo tests for elsewhere -
# so if you change one, change both, and this comment is the reminder.
guard() { grep -qE '^[[:space:]]*ffi[[:space:]]*=[[:space:]]*true' "$1"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
F="$WORK/foundry.toml"
fail=0

# ── the shipped config must pass ─────────────────────────────────────────────
if guard "$CONFIG"; then
  echo "FAIL the shipped foundry.toml enables ffi"
  fail=1
else
  echo "ok   the shipped foundry.toml does not enable ffi"
fi

# ── THE CONTROL: the guard must FIRE on the real defect ──────────────────────
#
# INSERTED INSIDE [profile.default], not appended. This is the trap: the file
# ends with [profile.default.invariant], so `printf 'ffi = true\n' >> file` puts
# the key in THAT table - where it is not the setting under test at all. A
# regression test written the obvious way would assert against a config that
# does not do what its author thinks, and pass for the wrong reason.
awk '/^\[profile\.default\]$/{print; print "ffi = true"; next} {print}' "$CONFIG" > "$F"
section=$(awk '/^\[/{s=$0} /^ffi = true/{print s; exit}' "$F")
if [ "$section" != "[profile.default]" ]; then
  echo "FAIL the fixture put ffi in $section, not [profile.default] - it tests nothing"
  fail=1
elif guard "$F"; then
  echo "ok   the guard fires on ffi = true in [profile.default]"
else
  echo "FAIL the guard missed ffi = true in [profile.default]"
  fail=1
fi

# ── and on any OTHER profile, which is deliberate ────────────────────────────
#
# The pattern is section-agnostic on purpose: a `[profile.ci]` enabling ffi runs
# on this runner just as surely as [profile.default] would.
cp "$CONFIG" "$F"
printf '\n[profile.ci]\nffi = true\n' >> "$F"
if guard "$F"; then
  echo "ok   the guard fires on another profile too"
else
  echo "FAIL the guard only looks at one profile"
  fail=1
fi

# ── and NOT on the spellings that do not enable it ───────────────────────────
cp "$CONFIG" "$F"
printf '\n[profile.default]\n# ffi = true\nffi = false\n' >> "$F"
if guard "$F"; then
  echo "FAIL the guard fires on a comment or on ffi = false"
  fail=1
else
  echo "ok   the guard ignores a commented line and ffi = false"
fi

exit "$fail"
