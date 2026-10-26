#!/bin/bash
# Rolls one relay image out by moving each relay's deploy tag, strictly one relay at a time (I-03): release-relay.yml
# runs it per environment, deploy-test.sh against two test relays. A relay pulls what its tag names
# (ptbk-relay-deploy on a timer), verifies the signature itself and rolls itself back if it does not come up and win
# back its engines. This script moves the tag, then watches the relay's /healthz from outside until it reports the new
# image and still reports it after the relay's own deploy window. On failure it moves the tag back and stops, so the
# relays after it keep running what they ran. Nothing here reaches into a relay.
#
#   rolling-deploy.sh sha256:<digest> <relay hostname>...
#
# REGISTRY_AUTH_FILE: skopeo's login for the registry. RELAY_IMAGE_REPOSITORY (ghcr.io/webgptorg/relay),
# RELAY_DEPLOY_INTERVAL_S (60, the relays' timer), RELAY_DEPLOY_WINDOW_S (60, their PTBK_DEPLOY_TIMEOUT_S) and
# RELAY_PULL_ALLOWANCE_S (120, pull and signature check) set the timing.
set -euo pipefail

usage() {
    echo "usage: rolling-deploy.sh sha256:<digest> <relay hostname>..." >&2
    exit 2
}

(($# >= 2)) || usage
digest=$1
shift
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || usage
for host in "$@"; do
    [[ $host =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$ && ${#host} -le 121 ]] || usage
done
repository=${RELAY_IMAGE_REPOSITORY:-ghcr.io/webgptorg/relay}
interval=${RELAY_DEPLOY_INTERVAL_S:-60}
window=${RELAY_DEPLOY_WINDOW_S:-60}
allowance=${RELAY_PULL_ALLOWANCE_S:-120}

tag_of() { echo "$repository:deploy-$1"; }

# What the relay's tag names (the digest of the manifest as stored), or nothing when it has none yet.
tagged() {
    local sum
    if sum=$(skopeo inspect --raw "docker://$(tag_of "$1")" 2>/dev/null | sha256sum); then
        echo "sha256:${sum%% *}"
    fi
}

move_tag() {
    local host=$1 target=$2
    skopeo copy --quiet --all --preserve-digests "docker://$repository@$target" "docker://$(tag_of "$host")"
    [[ $(tagged "$host") == "$target" ]]
}

# The image the relay says it runs, from its own hostname with a publicly trusted certificate.
reported() {
    curl -fsS --max-time 5 -o /dev/null -D - "https://$1/healthz" 2>/dev/null |
        tr -d '\r' | sed -n 's/^ptbk-relay-image: *//Ip' || true
}

# The relay picks the tag up within one timer interval, then needs the pull, the signature check and its own window
# to settle; it reports the new image as soon as it starts it, so it must still do so once that window has passed.
watch() {
    local host=$1 target=$2 deadline=$((SECONDS + interval + allowance + window)) seen
    until [[ $(reported "$host") == "$target" ]]; do
        ((SECONDS < deadline)) || {
            echo "$host did not start $target in time" >&2
            return 1
        }
        sleep 2
    done
    echo "$host started $target; watching it through its deploy window"
    deadline=$((SECONDS + window + 15))
    while ((SECONDS < deadline)); do
        seen=$(reported "$host")
        if [[ -n $seen && $seen != "$target" ]]; then
            echo "$host went back to $seen" >&2
            return 1
        fi
        sleep 2
    done
    [[ $(reported "$host") == "$target" ]]
}

done_hosts=()
for host in "$@"; do
    printf '\n== %s: %s\n' "$host" "$digest"
    previous=$(tagged "$host")
    if [[ $previous == "$digest" && $(reported "$host") == "$digest" ]]; then
        echo "$host already runs $digest"
    else
        move_tag "$host" "$digest"
        if ! watch "$host" "$digest"; then
            if [[ -n $previous && $previous != "$digest" ]]; then
                move_tag "$host" "$previous" || echo "::error::could not move $(tag_of "$host") back" >&2
                echo "moved $(tag_of "$host") back to $previous"
            fi
            echo "::error::$host did not take $digest and rolled itself back; not touched: ${*:${#done_hosts[@]}+2}" >&2
            exit 1
        fi
    fi
    done_hosts+=("$host")
    echo "$host runs $digest"
done
printf '\nAll %d relays run %s.\n' "${#done_hosts[@]}" "$digest"
