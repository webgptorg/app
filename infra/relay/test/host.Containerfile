# A relay host for the deploy test (deploy-test.sh): Debian 13 with systemd as PID 1, rootful Podman and skopeo,
# the packages the deploy relies on. The test installs the user data's own files, users and cosign into it.
FROM docker.io/library/debian:trixie@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl dbus openssl podman python3 python3-yaml skopeo systemd \
        systemd-sysv \
    && rm -rf /var/lib/apt/lists/* \
    && systemctl mask getty.target console-getty.service systemd-firstboot.service systemd-modules-load.service

STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]
