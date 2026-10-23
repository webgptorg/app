#!/bin/bash
# Checks the rendered user data and every host file it writes, inside the tools image (test/tools.Containerfile),
# which is thrown away afterwards: the files are installed at their real paths so systemd and sshd judge them as the
# host will. Called by check.sh with the user data as $1 and the repo's infra/ mounted at /infra.
set -euo pipefail

user_data=$1
infra=/infra

step() { printf '\n== %s\n' "$*"; }

step "cloud-init schema"
cloud-init schema --config-file "$user_data" --annotate

step "install the files the user data writes"
python3 - "$user_data" <<'PY'
import os, sys, yaml

with open(sys.argv[1]) as f:
    config = yaml.safe_load(f)
for entry in config["write_files"]:
    path = entry["path"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as out:
        out.write(entry["content"])
    os.chmod(path, int(entry["permissions"], 8))
    print(path)
PY
useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin ptbk-relay 2>/dev/null
useradd --no-create-home --shell /bin/bash ci

step "nft -c"
nft -c -f /etc/nftables.conf

step "systemd-analyze verify"
systemd-analyze verify --man=no /etc/systemd/system/ptbk-relay.service /etc/systemd/system/ptbk-relay-cert.service \
    /etc/systemd/system/ptbk-relay-cert.timer /etc/systemd/system/ptbk-relay-deploy.service \
    /etc/systemd/system/ptbk-relay-deploy.timer

# The certificate unit runs lego and holds a DNS token, so it is sandboxed as far as systemd allows. The relay unit
# runs rootful podman, which needs most of the host; the relay process itself is confined by the container flags.
# The thresholds catch a hardening option that is dropped.
step "systemd-analyze security"
systemd-analyze security --offline=true --threshold=20 /etc/systemd/system/ptbk-relay-cert.service
systemd-analyze security --offline=true --threshold=87 /etc/systemd/system/ptbk-relay.service
systemd-analyze security --offline=true --threshold=54 /etc/systemd/system/ptbk-relay-deploy.service

step "sshd -t"
ssh-keygen -A >/dev/null
mkdir -p /run/sshd
sshd -t

step "unbound-checkconf"
# On the host, unbound's start-up helper seeds the trust anchor from the same file.
install -o unbound -m 0644 /usr/share/dns/root.key /var/lib/unbound/root.key
unbound-checkconf

step "shellcheck"
shellcheck --external-sources \
    "$infra/relay/verify.sh" \
    "$infra"/relay/scripts/*.sh \
    "$infra"/relay/test/*.sh \
    "$infra"/cloudflare/scripts/*.sh \
    "$infra"/relay/modules/cloud-init/files/{renew-certificate,install-certificate,install-cosign,ptbk-relay-deploy} \
    /usr/local/libexec/ptbk-relay/install-lego
shellcheck --shell=sh "$infra/relay/modules/cloud-init/files/dhclient-enter-hook"

printf '\nAll host file checks passed.\n'
