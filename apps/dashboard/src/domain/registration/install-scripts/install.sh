#!/usr/bin/env bash
# Promptbook for macOS and Linux: prepares Git, Node.js and npm, installs the exact CLI and pairs this computer.
#   curl -fsSL __PTBK_ORIGIN__/install.sh | PTBK_LINK=<pairing code> bash
# Served per request with the current release filled in; it carries no pairing data. Everything runs from the call on
# the last line, so a download cut short defines functions at most and never starts the installer.
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

# Only the person at the terminal can say yes to anything run as administrator; unattended runs answer no.
confirm() {
    local answer=
    if [[ -t 2 ]] && ( : </dev/tty ) 2>/dev/null; then read -r -p "$1 [y/N] " answer </dev/tty || answer=; fi
    [[ "$answer" == [yY]* ]]
}

approve_system_install() {
    printf 'Promptbook needs %s. Your package manager will run as administrator: %s\n' "$1" "$2" >&2
    confirm 'Install it now?' || fail "Install $1 yourself, then run the same pairing command again."
}

# The engine runs as a systemd user service, which systemd stops at logout and starts again only at the next login
# unless the user lingers. logind answers `no` only where it runs and linger is off; root and other hosts are skipped.
enable_linger() {
    local user
    [[ "$platform" == linux && "$(id -u)" != 0 ]] || return 0
    user=$(id -un)
    [[ "$(loginctl show-user "$user" --property=Linger --value 2>/dev/null || true)" == no ]] || return 0
    printf 'So the project starts again after a reboot without you logging in, systemd needs to keep your services running. As administrator: loginctl enable-linger %s\n' "$user" >&2
    if confirm 'Allow it now?' && as_admin loginctl enable-linger "$user"; then return; fi
    printf 'Linger not enabled: the project starts again only when %s logs in. Later: sudo loginctl enable-linger %s\n' "$user" "$user" >&2
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
    elif command -v apt-get >/dev/null; then
        approve_system_install Git 'apt-get update && apt-get install -y git'
        as_admin apt-get update && as_admin apt-get install -y git
    elif command -v dnf >/dev/null; then approve_system_install Git 'dnf install -y git'; as_admin dnf install -y git
    elif command -v zypper >/dev/null; then
        approve_system_install Git 'zypper --non-interactive install git'
        as_admin zypper --non-interactive install git
    elif command -v pacman >/dev/null; then
        approve_system_install Git 'pacman -S --needed --noconfirm git'
        as_admin pacman -S --needed --noconfirm git
    elif command -v apk >/dev/null; then approve_system_install Git 'apk add git'; as_admin apk add git
    else fail 'Install Git using your distribution, then run the same pairing command again.'
    fi
    git --version >/dev/null || fail 'Git is unavailable. Complete its installation and retry.'
}

prepare_node() {
    if compatible_tools; then return; fi
    if [[ "$platform" == linux && -f /etc/alpine-release ]]; then
        approve_system_install 'Node.js and npm' 'apk add nodejs npm'
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
    local version='__PTBK_VERSION__' code="${PTBK_LINK:-}" link platform root prefix work stage cli
    # Nothing this script starts needs the code in its environment; the CLI gets the link on stdin or from the terminal.
    unset PTBK_LINK
    [[ "$code" =~ ^[a-z2-7]{25}[aeimquy4]$ ]] || fail 'Set PTBK_LINK to the pairing code shown in Promptbook App.'
    link="__PTBK_ORIGIN__/link#$code"
    case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'Use the Windows PowerShell command on Windows.' ;; esac
    prepare_git
    # Only a CLI in our own prefix is reused. Any other `ptbk` on PATH may be a wrapper that runs as someone else.
    root="$HOME/.local/share/promptbook"
    prefix="$root/cli/$version"
    mkdir -p "$root/cli"
    # A running project may have updated this installation in place. An older release gets its own prefix.
    while [[ -e "$prefix" ]] && ! PATH="$prefix/bin:$PATH" matches_version "$prefix/bin/ptbk"; do prefix="$prefix.retry"; done
    PATH="$prefix/bin:$PATH"
    if [[ ! -x "$prefix/bin/ptbk" ]]; then install_cli; fi
    cli="$prefix/bin/ptbk"
    matches_version "$cli" || fail 'Promptbook version mismatch. Pairing stopped.'
    install_launcher
    enable_linger
    # The CLI shows first access automatically only with terminal stdin and stdout.
    if [[ -t 1 ]] && ( : </dev/tty ) 2>/dev/null; then
        "$cli" init --prepare-only --link "$link" </dev/tty
    else
        printf '%s\n' "$link" | "$cli" init --prepare-only --link-stdin
    fi
}

main "$@"
