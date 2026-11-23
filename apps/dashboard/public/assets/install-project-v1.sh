#!/usr/bin/env bash
# Desktop pairing bootstrap. The public download carries no pairing data; Bash receives the link on fd 3.
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

compatible_tools() {
    local npm_version
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major >= 24 || (major === 22 && minor >= 13) ? 0 : 1)' 2>/dev/null &&
        npm_version=$(npm --version 2>/dev/null) && [[ "$npm_version" =~ ^[1-9][0-9]+\. ]]
}

matches_version() {
    local reported
    reported=$("$1" --version) && [[ "$reported" == "$version" ]]
}

as_admin() {
    if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo "$@"; fi
}

prepare_git() {
    # Apple's /usr/bin/git is a launcher that opens a dialog when the developer tools are absent.
    if [[ "$platform" != darwin || "$(command -v git || true)" != /usr/bin/git ]] || xcode-select -p >/dev/null 2>&1; then
        if git --version >/dev/null 2>&1; then return; fi
    fi
    if [[ "$platform" == darwin ]]; then
        if command -v brew >/dev/null; then
            brew install git
        else
            printf '%s\n' 'Approve the Apple Command Line Tools installation. Pairing will continue when Git is ready.'
            xcode-select --install
            for ((i=0; i<360; i++)); do
                if xcode-select -p >/dev/null 2>&1; then break; fi
                sleep 5
            done
        fi
    elif command -v apt-get >/dev/null; then as_admin apt-get update && as_admin apt-get install -y git
    elif command -v dnf >/dev/null; then as_admin dnf install -y git
    elif command -v zypper >/dev/null; then as_admin zypper --non-interactive install git
    elif command -v pacman >/dev/null; then as_admin pacman -S --needed --noconfirm git
    elif command -v apk >/dev/null; then as_admin apk add git
    else fail 'Install Git using your distribution, then run the same pairing command again.'
    fi
    git --version >/dev/null || fail 'Git is unavailable. Complete its installation and retry.'
}

prepare_node() {
    if compatible_tools; then return; fi
    if [[ "$platform" == linux && -f /etc/alpine-release ]]; then
        as_admin apk add nodejs npm
    else
        local arch sums digest archive release actual
        case "$(uname -m)" in
            arm64|aarch64) arch=arm64 ;;
            x86_64|amd64) arch=x64 ;;
            *) fail 'This architecture needs a compatible Node.js and npm from your distribution.' ;;
        esac
        sums="$work/SHASUMS256.txt"
        curl -fsSL --retry 2 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$sums"
        read -r digest archive < <(awk -v target="-$platform-$arch.tar.gz" 'index($2,target) && $2 ~ /\.tar\.gz$/ {print $1,$2; exit}' "$sums") ||
            fail 'The official Node.js checksum list has no matching archive.'
        [[ "$digest" =~ ^[[:xdigit:]]{64}$ && "$archive" =~ ^node-(v24\.[0-9]+\.[0-9]+)-[a-z0-9]+-[a-z0-9]+\.tar\.gz$ ]] ||
            fail 'Invalid Node.js checksum entry.'
        release="${BASH_REMATCH[1]}"
        [[ "$archive" == "node-$release-$platform-$arch.tar.gz" ]] || fail 'Unexpected Node.js platform.'
        curl -fsSL --retry 2 "https://nodejs.org/dist/$release/$archive" -o "$work/node.tar.gz"
        if [[ "$platform" == darwin ]]; then actual=$(shasum -a 256 "$work/node.tar.gz")
        else actual=$(sha256sum "$work/node.tar.gz"); fi
        [[ "${actual%% *}" == "$digest" ]] || fail 'Node.js checksum mismatch.'
        tar -xzf "$work/node.tar.gz" -C "$stage" --strip-components=1
    fi
    # Bash can still remember the incompatible executables that were on PATH before extraction.
    hash -r
    compatible_tools || fail 'Promptbook needs Node.js 22.13+ in the 22 line or 24+, and npm 10+.'
}

install_cli() (
    work=$(mktemp -d "$root/.install.XXXXXXXX")
    trap 'rm -rf -- "$work"' EXIT
    stage="$work/prefix"
    mkdir -p "$stage/bin"
    PATH="$stage/bin:$PATH"
    prepare_node
    if [[ ! -e "$stage/bin/node" ]]; then
        ln -s "$(type -P node)" "$stage/bin/node"
        ln -s "$(type -P npm)" "$stage/bin/npm"
    fi
    npm install --global --prefix "$stage" --registry=https://registry.npmjs.org/ "ptbk@$version"
    matches_version "$stage/bin/ptbk" || fail 'The installed Promptbook version does not match.'
    # Use the same installation marker as Promptbook's VPS bootstrap so engine updates target this prefix.
    printf '%s\n' '{"method":"shell","root":"lib/node_modules/ptbk"}' > "$stage/ptbk-installation.json"
    # Publish a complete version atomically. A concurrent install of the same version can win the rename.
    node -e 'const fs = require("node:fs"); try { fs.renameSync(process.argv[1], process.argv[2]); } catch (e) { if (!["EEXIST","ENOTEMPTY"].includes(e.code)) throw e; }' "$stage" "$prefix"
)

install_launcher() {
    local profile launcher login_shell="${SHELL:-}"
    mkdir -p "$root/bin"
    launcher=$(mktemp "$root/bin/.ptbk.XXXXXXXX")
    printf '#!/bin/sh\nexport PATH="$HOME/.local/share/promptbook/cli/%s/bin:$PATH"\nexec "$HOME/.local/share/promptbook/cli/%s/bin/ptbk" "$@"\n' "${prefix##*/}" "${prefix##*/}" > "$launcher"
    chmod 755 "$launcher"
    mv -f "$launcher" "$root/bin/ptbk"
    case ":${PATH}:" in *":$root/bin:"*) return ;; esac
    case "${login_shell##*/}" in
        zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
        bash) profile="$HOME/.bashrc"; if [[ "$platform" == darwin ]]; then profile="$HOME/.bash_profile"; fi ;;
        *) printf 'Promptbook CLI: %s\n' "$root/bin/ptbk"; return ;;
    esac
    local path_line='export PATH="$HOME/.local/share/promptbook/bin:$PATH"'
    if ! grep -Fqx "$path_line" "$profile" 2>/dev/null; then
        printf '\n%s\n' "$path_line" >> "$profile" || printf 'Promptbook CLI: %s\n' "$root/bin/ptbk" >&2
    fi
}

main() {
    [[ $# == 1 && "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail 'Expected an exact Promptbook version.'
    local version="$1" link platform root prefix work stage cli
    IFS= read -r link <&3 || fail 'Missing pairing link.'
    exec 3<&-
    case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'Use the Windows PowerShell command on Windows.' ;; esac
    prepare_git
    if compatible_tools && command -v ptbk >/dev/null && matches_version ptbk; then
        cli=$(command -v ptbk)
    else
        root="$HOME/.local/share/promptbook"
        prefix="$root/cli/$version"
        mkdir -p "$root/cli"
        # A running project may have updated this installation in place. An older copied command gets its own prefix.
        while [[ -e "$prefix" ]] && ! PATH="$prefix/bin:$PATH" matches_version "$prefix/bin/ptbk"; do prefix="$prefix.retry"; done
        PATH="$prefix/bin:$PATH"
        if [[ ! -x "$prefix/bin/ptbk" ]]; then install_cli; fi
        cli="$prefix/bin/ptbk"
        matches_version "$cli" || fail 'Promptbook version mismatch. Pairing stopped.'
        install_launcher
    fi
    printf '%s\n' "$link" | "$cli" init --prepare-only --link-stdin
}

# Keep the invocation last, so an incomplete download cannot start the installer.
main "$@"
