#!/bin/bash
# Checks a relay host against the hardening rules of I-01 and exits non-zero if any fails.
#
#   infra/relay/verify.sh <admin>@<host> [ssh option ...]   from an admin machine: runs itself on the host with sudo
#   sudo infra/relay/verify.sh --local                      on the host itself
#
# The relay checks need a running relay, so they fail before the first deploy (I-03), as they should.
set -euo pipefail

if [[ ${1:-} != --local ]]; then
    if [[ $# -lt 1 ]]; then
        echo "usage: $0 <ssh destination> [ssh option ...] | --local" >&2
        exit 2
    fi
    destination=$1
    shift
    exec ssh "$@" "$destination" 'sudo -n bash -s -- --local' <"$0"
fi

export LC_ALL=C
failures=0

pass() { printf 'ok    %s\n' "$1"; }
fail() {
    printf 'FAIL  %s\n' "$1"
    if [[ -n ${2:-} ]]; then printf '      %s\n' "$2"; fi
    failures=$((failures + 1))
}
check() {
    local description=$1
    shift
    if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}
report() {
    if [[ -z $2 ]]; then pass "$1"; else fail "$1" "$(tr '\n' ' ' <<<"$2")"; fi
}

env_value() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1; }
at_least() { [[ $1 =~ ^[0-9]+$ ]] && ((10#$1 >= $2)); }
# Never grep -q at the end of a pipe: it exits at the first match, and under pipefail the writer's SIGPIPE then
# fails the check.
apt_setting() { apt-config dump | grep -xF "$1" >/dev/null; }
chain_policy_drop() { nft list chain inet ptbk "$1" | grep 'policy drop;' >/dev/null; }
journald_setting() {
    systemd-analyze cat-config systemd/journald.conf | grep -E "^$1=" | tail -n 1 | grep -Ex "$1=$2" >/dev/null
}
only_local_nameservers() {
    awk '$1 == "nameserver" { any = 1; if ($2 != "127.0.0.1" && $2 != "::1") bad = 1 } END { exit bad || !any }' \
        /etc/resolv.conf
}
runs_as_relay_user() { awk '/^Uid:/ { exit !($2 == 10001 && $3 == 10001 && $4 == 10001) }' "/proc/$1/status"; }
holds_no_capabilities() { awk '/^Cap(Inh|Prm|Eff|Amb):/ && $2 !~ /^0+$/ { bad = 1 } END { exit bad }' "/proc/$1/status"; }
dnssec_authenticates() {
    dig @127.0.0.1 +dnssec +time=5 +tries=2 isc.org SOA | grep -E 'flags:[a-z ]* ad[ ;]' >/dev/null
}
dnssec_refuses_bogus() {
    dig @127.0.0.1 +time=5 +tries=2 dnssec-failed.org A | grep 'status: SERVFAIL' >/dev/null
}

relay_env=/etc/ptbk-relay/relay.env
engine_domain=$(env_value "$relay_env" RELAY_ENGINE_DOMAIN)
max_connections=$(env_value "$relay_env" RELAY_MAX_CONNECTIONS)
max_connections=${max_connections:-10000}

echo "== relay service"
check "ptbk-relay.service has Restart=always" test "$(systemctl show -P Restart ptbk-relay.service)" = always
check "ptbk-relay.service is active" systemctl is-active --quiet ptbk-relay.service
check "the relay image is pinned by digest" \
    grep -Eq '^PTBK_RELAY_IMAGE=[^@[:space:]]+@sha256:[0-9a-f]{64}$' /etc/ptbk-relay/image.env

pid=$(podman inspect --format '{{.State.Pid}}' ptbk-relay 2>/dev/null || true)
if [[ $pid =~ ^[1-9][0-9]*$ ]]; then
    cgroup=/sys/fs/cgroup$(cut -d: -f3- "/proc/$pid/cgroup")
    root_processes=$(while read -r process; do
        awk -v p="$process" '/^Uid:/ { for (i = 2; i <= 5; i++) if ($i == 0) { print p; exit } }' \
            "/proc/$process/status" 2>/dev/null || true
    done <"$cgroup/cgroup.procs")
    report "no process of the relay container runs as root" "$root_processes"
    check "the relay runs as uid 10001" runs_as_relay_user "$pid"
    check "the relay holds no capabilities" holds_no_capabilities "$pid"
    check "the relay cannot gain privileges (no_new_privs)" grep -Eq '^NoNewPrivs:[[:space:]]+1$' "/proc/$pid/status"
    check "the relay's root filesystem is read-only" \
        test "$(podman inspect --format '{{.HostConfig.ReadonlyRootfs}}' ptbk-relay)" = true
    check "the relay container has a memory limit" grep -Eq '^[0-9]+$' "$cgroup/memory.max"
    nofile=$(awk '/^Max open files/ { print $4 }' "/proc/$pid/limits")
    check "the relay may open at least 4 x RELAY_MAX_CONNECTIONS files" at_least "$nofile" $((4 * max_connections))
    check "the relay's V8 heap is capped (--max-old-space-size)" \
        grep -qz -e '--max-old-space-size=[0-9]' "/proc/$pid/environ" "/proc/$pid/cmdline"
    node_version=$(podman exec ptbk-relay node --version 2>/dev/null || true)
    if [[ $node_version =~ ^v24\.([0-9]+)\. ]] && ((BASH_REMATCH[1] >= 17)); then
        pass "the relay runs Node 24.17 or later ($node_version)"
    else
        fail "the relay runs Node 24.17 or later" "found: ${node_version:-none}"
    fi
else
    fail "the relay container is running"
fi

echo "== credentials"
check "the credentials directory is root-only" test "$(stat -c '%U %a' /etc/ptbk-relay/credentials)" = "root 700"
unexpected=$(find /etc/ptbk-relay/credentials -mindepth 1 \
    -not \( -type f -user root -perm 0600 -regex '.*/\(registry-token\|metrics-token\|tls\.crt\|tls\.key\|acme-dns-token\)' \) \
    2>/dev/null || echo /etc/ptbk-relay/credentials)
report "credentials are the relay's own, in root-owned 0600 files" "$unexpected"

echo "== kernel"
check "net.ipv4.tcp_syncookies = 1" test "$(sysctl -n net.ipv4.tcp_syncookies)" = 1
check "net.core.somaxconn >= 4096" at_least "$(sysctl -n net.core.somaxconn)" 4096
check "net.ipv4.tcp_max_syn_backlog >= 4096" at_least "$(sysctl -n net.ipv4.tcp_max_syn_backlog)" 4096
check "net.netfilter.nf_conntrack_max >= 262144" at_least "$(sysctl -n net.netfilter.nf_conntrack_max)" 262144
# A listening socket's Send-Q is its backlog, already capped at somaxconn.
listen_backlog=$(ss -H -l -n -t 'sport = :443' | awk '{ print $3; exit }')
check "the relay listens on 443 with a backlog of net.core.somaxconn" \
    test "${listen_backlog:-none}" = "$(sysctl -n net.core.somaxconn)"

echo "== firewall"
check "nftables.service is active" systemctl is-active --quiet nftables.service
check "nftables.service starts at boot" systemctl is-enabled --quiet nftables.service
for chain in input forward output; do
    check "$chain policy is drop" chain_policy_drop "$chain"
done
# DHCP's client port is reachable only by the provider's DHCP replies (nftables).
public_listeners=$(ss -H -l -n -t -u | awk '{
    address = $5; port = address; sub(/.*:/, "", port); host = substr(address, 1, length(address) - length(port) - 1)
    if (host ~ /^(127\.|\[::1\]|\[::ffff:127\.)/ || host ~ /%lo$/) next
    if ($1 == "tcp" && (port == 22 || port == 443)) next
    if ($1 == "udp" && port == 68) next
    print $1 " " address
}')
report "nothing but 443 and 22 listens publicly" "$public_listeners"

echo "== DNS"
check "unbound.service is active" systemctl is-active --quiet unbound.service
check "the host resolves through the local resolver only" only_local_nameservers
check "the relay resolves through the local resolver" test "$(env_value "$relay_env" RELAY_DNS_SERVERS)" = 127.0.0.1
check "DNSSEC: a signed zone's answer is authenticated" dnssec_authenticates
check "DNSSEC: a bogus signature is refused" dnssec_refuses_bogus

echo "== SSH"
sshd_config=$(sshd -T 2>/dev/null || true)
for setting in "passwordauthentication no" "kbdinteractiveauthentication no" "permitrootlogin no" \
    "pubkeyauthentication yes" "permitemptypasswords no"; do
    check "sshd: $setting" grep -qx "$setting" <<<"$sshd_config"
done
report "no account has a usable password" "$(awk -F: '$2 !~ /^[!*]/ { print $1 }' /etc/shadow)"

echo "== certificate"
check "ptbk-relay-cert.timer is enabled" systemctl is-enabled --quiet ptbk-relay-cert.timer
# Debian's lego is built without the Cloudflare DNS provider; cloud-init installs the pinned release instead.
check "lego is installed from the pinned release" /usr/local/bin/lego --version
check "Debian's lego is not installed" test -z "$(dpkg-query -W -f='${db:Status-Status}' lego 2>/dev/null | grep -x installed)"

echo "== deploys"
deploy_env=/etc/ptbk-relay/deploy.env
report "no deploy user or deploy key: relays pull their deploys" \
    "$(getent passwd ptbk-deploy; ls /etc/sudoers.d/ptbk-deploy 2>/dev/null; grep -ls 'command=' /home/*/.ssh/authorized_keys 2>/dev/null)"
check "ptbk-relay-deploy.timer is active" systemctl is-active --quiet ptbk-relay-deploy.timer
check "cosign is installed" /usr/local/bin/cosign version
check "deploys accept only release-relay.yml on main" test "$(env_value "$deploy_env" PTBK_DEPLOY_CERT_IDENTITY)" = \
    https://github.com/webgptorg/app/.github/workflows/release-relay.yml@refs/heads/main
check "deploys verify against Sigstore's public-good root" test -z "$(env_value "$deploy_env" PTBK_DEPLOY_TRUSTED_ROOT)"

echo "== updates, time, logs"
check "unattended-upgrades is installed" dpkg-query -W unattended-upgrades
check "package lists update daily" apt_setting 'APT::Periodic::Update-Package-Lists "1";'
check "unattended upgrades run daily" apt_setting 'APT::Periodic::Unattended-Upgrade "1";'
check "unattended upgrades reboot when needed" apt_setting 'Unattended-Upgrade::Automatic-Reboot "true";'
check "apt-daily-upgrade.timer is enabled" systemctl is-enabled --quiet apt-daily-upgrade.timer
check "chrony.service is active" systemctl is-active --quiet chrony.service
check "journald stores logs persistently" journald_setting Storage persistent
check "journald keeps logs at most 7 days" journald_setting MaxRetentionSec '([1-7]d(ay)?|[1-9][0-9]*(s|min|h))'

echo "== no engine keys or certificates"
# Private keys a relay may hold: the SSH host keys, its own TLS key, and lego's account and certificate keys.
allowed_keys='^(/etc/ssh/ssh_host_[a-z0-9]+_key|/etc/ptbk-relay/credentials/tls\.key|/var/lib/private/ptbk-relay-cert/.*)$'
# A PEM header alone on its line is a key file; documentation that quotes one inline or indented is not.
foreign_keys=$(grep -rIlsE --devices=skip --exclude-dir={proc,sys,dev,run} -e '^-----BEGIN [A-Z ]*PRIVATE KEY-----$' / |
    grep -Ev "$allowed_keys" || true)
named_keys=$(find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /run \) -prune -o \
    -type f -iname '*engine*key*' -print 2>/dev/null || true)
report "no private key besides the SSH host keys and the relay's own" "$(printf '%s\n' "$foreign_keys" "$named_keys" | sed '/^$/d')"

if [[ -z $engine_domain ]]; then
    fail "no certificate for the engine domain" "RELAY_ENGINE_DOMAIN is not set in $relay_env"
else
    covers_engine_domain="(DNS:|CN ?= ?)([*][.])?([a-z0-9-]+[.])*${engine_domain//./\\.}([,/[:space:]]|$)"
    engine_certificates=$(grep -rIlsx --devices=skip --exclude-dir={proc,sys,dev,run} -e '-----BEGIN CERTIFICATE-----' / |
        grep -Ev '/(etc/ssl/certs|usr/share/ca-certificates)/|/certifi/cacert\.pem$' |
        while IFS= read -r file; do
            # Every certificate in the file, not only the first.
            awk '/-----BEGIN CERTIFICATE-----/ { pem = "" } { pem = pem $0 "\n" }
                /-----END CERTIFICATE-----/ { cmd = "openssl x509 -noout -subject -ext subjectAltName"; printf "%s", pem | cmd; close(cmd) }' \
                "$file" 2>/dev/null | grep -Ei "$covers_engine_domain" >/dev/null && echo "$file"
        done || true)
    report "no certificate for the engine domain ($engine_domain)" "$engine_certificates"
fi

echo
if ((failures > 0)); then
    echo "$failures check(s) failed"
    exit 1
fi
echo "all checks passed"
