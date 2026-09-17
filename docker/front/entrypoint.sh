#!/bin/sh
# Renders rpc-proxy.conf.template and starts nginx on it.
#
# Five values, defaulted to exactly what used to be hard-coded, so a compose
# deployment behaves identically and a deployment that cannot resolve service
# names or choose its own ports can point this anywhere.
set -eu

export NODE_UPSTREAM="${NODE_UPSTREAM:-http://chain:8545}"
export OTTERSCAN_UPSTREAM="${OTTERSCAN_UPSTREAM:-http://otterscan:80}"
export FRONT_HTTP_PORT="${FRONT_HTTP_PORT:-80}"
export FRONT_RPC_PORT="${FRONT_RPC_PORT:-8545}"
# Derived from the request by default: `$fwd_scheme` is the proxy's scheme when
# there is one and nginx's own otherwise, and `$http_host` is the host the
# browser actually asked for, so an ssh forward advertises the forwarded port.
# These two are nginx variables and are deliberately NOT expanded here - see the
# guard below. A deployment behind something that rewrites Host sets this
# outright instead.
export ERIGON_URL="${ERIGON_URL:-\$fwd_scheme://\$http_host/rpc}"

TEMPLATE=/etc/nginx/rpc-proxy.conf.template
RENDERED=/tmp/rpc-proxy.conf

# THE EXPLICIT LIST IS THE WHOLE POINT. Called with no arguments, envsubst
# substitutes EVERY $NAME it finds - including `$http_host`, `$scheme`,
# `$request_uri`, `$node` and `$otterscan`, which belong to nginx and are
# resolved per request. They are not set in this environment, so envsubst would
# replace them with empty strings and nginx would start happily on a config that
# proxies to nothing and advertises an RPC at "://".
envsubst '${NODE_UPSTREAM} ${OTTERSCAN_UPSTREAM} ${FRONT_HTTP_PORT} ${FRONT_RPC_PORT} ${ERIGON_URL}' \
  < "$TEMPLATE" > "$RENDERED"

# ...and this checks that it worked, because the failure above is silent. Each
# of these is an nginx variable that MUST still be in the rendered file; if one
# is missing, envsubst took it and the config is wrong in a way `nginx -t`
# cannot see - it is valid syntax that resolves to nothing.
for v in http_host scheme request_uri node otterscan fwd_scheme; do
  if ! grep -q "\$$v" "$RENDERED"; then
    echo "front: envsubst consumed \$$v - the variable list in this script is wrong" >&2
    exit 1
  fi
done

nginx -t -c "$RENDERED"
exec nginx -c "$RENDERED" -g "daemon off;"
