#!/usr/bin/env bash
# Runs njs-units.js under the STANDALONE njs from the same pinned image the
# front uses:
#   ./docker/front/test/run-units.sh
#
# WHY A SCRIPT AND NOT ONE `docker run`. Two of the checks are about reading the
# deployment manifest, and one of them is the failure that actually happened:
# the file is there, and the process cannot read it. That is not reproducible as
# a committed fixture - git records no owner and only the exec bit - so the
# unreadable file is built here, and the interpreter is run as a NON-ROOT uid.
# Run as root it would read the 0600 file happily and the check would pass while
# testing nothing.
set -euo pipefail

IMAGE=otterscan/otterscan:v2.11.0
HERE="$(cd "$(dirname "$0")" && pwd)"
FRONT="$(cd "$HERE/.." && pwd)"

FIX=$(mktemp -d)
trap 'chmod -R u+rwX "$FIX" 2>/dev/null || true; rm -rf "$FIX"' EXIT
chmod 0755 "$FIX"

cat > "$FIX/with-registry.json" <<'JSON'
{"schema":1,"modules":[{"kind":"token","address":"0x1111111111111111111111111111111111111111"},
                       {"kind":"names","address":"0x2222222222222222222222222222222222222222"}]}
JSON
cat > "$FIX/no-registry.json" <<'JSON'
{"schema":1,"modules":[{"kind":"token","address":"0x1111111111111111111111111111111111111111"}]}
JSON
cat > "$FIX/no-modules.json" <<'JSON'
{"schema":1}
JSON
printf 'this is not json' > "$FIX/broken.json"
# The one that matters: present, and unreadable by the uid below. 0600 owned by
# whoever runs this script; the container runs as 101, which is not that.
cp "$FIX/with-registry.json" "$FIX/unreadable.json"
chmod 0600 "$FIX/unreadable.json"
chmod 0644 "$FIX"/with-registry.json "$FIX"/no-registry.json "$FIX"/no-modules.json "$FIX"/broken.json

exec docker run --rm -u 101:101 \
  -v "$FRONT/rpc_filter.js:/etc/nginx/njs/rpc_filter.js:ro" \
  -v "$FRONT/overview.js:/etc/nginx/njs/overview.js:ro" \
  -v "$HERE/njs-units.js:/t/njs-units.js:ro" \
  -v "$FIX:/fixtures:ro" \
  --entrypoint njs "$IMAGE" /t/njs-units.js
