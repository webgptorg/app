#!/bin/sh
# Entry point of Dockerfile.dev. The origin is set at start, so one image serves any dev hostname without a rebuild:
# `vite preview` reads the Worker's vars from dist/<worker>/.dev.vars.
set -eu
: "${DASHBOARD_ORIGIN:?set DASHBOARD_ORIGIN, e.g. https://app.ptbk.test}"
: "${DASHBOARD_TLS_CERT:?set DASHBOARD_TLS_CERT to the certificate path}"
: "${DASHBOARD_TLS_KEY:?set DASHBOARD_TLS_KEY to the key path}"

printf "DASHBOARD_ORIGIN='%s'\n" "$DASHBOARD_ORIGIN" > dist/ptbk_dashboard/.dev.vars
node_modules/.bin/wrangler d1 migrations apply DB --local
exec node_modules/.bin/vite preview --mode https
