#!/usr/bin/env bash
# Promptbook for an Ubuntu 24.04 x64 server: runs Promptbook's own server bootstrap, pinned to a reviewed commit and
# verified by SHA-256 before anything is elevated, and pairs the engine, which runs as the ordinary promptbook user.
#   curl -fsSL __PTBK_ORIGIN__/install-server.sh | PTBK_LINK=<pairing code> bash
# Served per request with the current release filled in; it carries no pairing data. Everything runs from the call on
# the last line, so a download cut short defines functions at most and never starts the installer.
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

main() {
    local version='__PTBK_VERSION__' code="${PTBK_LINK:-}" elevate=env
    unset PTBK_LINK
    [[ "$code" =~ ^[a-z2-7]{25}[aeimquy4]$ ]] || fail 'Set PTBK_LINK to the pairing code shown in Promptbook App.'
    bootstrap=$(mktemp)
    trap 'rm -f -- "$bootstrap"' EXIT
    curl -fsSL --retry 2 -o "$bootstrap" \
        https://raw.githubusercontent.com/webgptorg/promptbook/__PTBK_BOOTSTRAP_REVISION__/deploy/ubuntu/install.sh
    printf '%s  %s\n' '__PTBK_BOOTSTRAP_SHA256__' "$bootstrap" | sha256sum --check --status - ||
        fail 'Promptbook server bootstrap checksum mismatch.'
    if [[ "$(id -u)" != 0 ]]; then sudo -v; elevate=sudo; fi
    printf '%s\n' "__PTBK_ORIGIN__/link#$code" |
        "$elevate" bash "$bootstrap" --version "$version" --prepare-only --link-stdin
}

main "$@"
