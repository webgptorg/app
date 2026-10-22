#!/bin/sh
# The registry-keys service (compose.dashboard.yaml), once per stack before the dashboard serves and the relays start:
# applies the migrations to the dashboard's local D1 and mints one registry key per relay into it with D-04's own mint
# script, valid for REGISTRY_KEY_DAYS (1 by default; the dev stack, which runs for days, sets 7). Each key goes only
# to /registry-tokens/<relay>/token, in a volume that only that relay mounts, owned by the relays' user (uid 1000,
# SERVICE_UID in src/stack.ts); everything else the script prints goes to the log.
set -eu
umask 077
cd /repo/apps/dashboard
node_modules/.bin/wrangler d1 migrations apply DB --local
for relay in "$@"; do
    dir="/registry-tokens/${relay}"
    output="$(node scripts/mint-relay-key.ts --relay "$relay" --local --days "${REGISTRY_KEY_DAYS:-1}")"
    printf '%s\n' "$output" | grep -E '^ptbk_rt_[A-Za-z0-9_-]{43}$' > "${dir}/token"
    printf '%s\n' "$output" | grep -vE '^ptbk_rt_' || true
    chown 1000:1000 "$dir" "${dir}/token"
    chmod 0700 "$dir"
    chmod 0400 "${dir}/token"
done
