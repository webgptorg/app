# The offline checks of scripts/check.sh run in this image: the same Debian release as the relay hosts, with the
# packages the user data installs, so systemd-analyze and cloud-init judge the files against the real versions.
FROM docker.io/library/debian:trixie@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        chrony cloud-init dns-root-data lego nftables openssh-server podman python3-yaml shellcheck sudo systemd unattended-upgrades \
        unbound \
    && rm -rf /var/lib/apt/lists/*
