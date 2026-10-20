#!/usr/bin/env bash
# Checks a dashboard deploy token against its documented scope (README, API tokens): it can reach Workers and D1 in
# its account, and it can neither read nor write DNS in any zone given. Run by a human with the token in the
# environment, never in CI. It changes nothing unless the token is over-privileged; then the probe TXT record it
# managed to create is reported and the script fails.
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./verify-deploy-token.sh <zone-id> [<zone-id>...]
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN to the deploy token}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID to the environment account}"
[[ $# -gt 0 ]] || { echo "usage: $0 <zone-id> [<zone-id>...]" >&2; exit 2; }

api=https://api.cloudflare.com/client/v4
failed=0

status() {
    curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"
}

expect() {
    local want=$1 what=$2 code
    shift 2
    code=$(status "$@")
    if [[ $want == allowed && $code == 2* ]] || [[ $want == refused && $code != 2* ]]; then
        echo "ok      $what ($code)"
    else
        echo "FAILED  $what should be $want, got $code" >&2
        failed=1
    fi
}

expect allowed "token is active" "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify"
expect allowed "list Workers scripts" "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts"
expect allowed "list D1 databases" "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database"

for zone in "$@"; do
    expect refused "read DNS in zone $zone" "$api/zones/$zone/dns_records"
    expect refused "write DNS in zone $zone (probe TXT _ptbk-token-check)" -X POST \
        -H 'Content-Type: application/json' \
        --data '{"type":"TXT","name":"_ptbk-token-check","content":"\"deploy token probe\"","ttl":60}' \
        "$api/zones/$zone/dns_records"
done

if [[ $failed != 0 ]]; then
    echo "The token is over- or under-privileged. Revoke it; delete any _ptbk-token-check TXT record it created." >&2
    exit 1
fi
