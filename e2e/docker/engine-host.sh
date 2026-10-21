#!/bin/sh
# The engine's host on engine-lan (X-02): owns the network namespace the mock engine joins, so the mock engine itself
# needs no capabilities. Its only route out is the gateway. It also serves a few ports on the LAN, so the tests that
# say "nothing reaches the engine from outside" aim at ports that are really open.
set -eu
: "${GATEWAY_LAN_IP:?}" "${ENGINE_HOST_PORTS:?}"
ip route replace default via "$GATEWAY_LAN_IP"
touch /tmp/engine-host-ready
# shellcheck disable=SC2086 # one argument per port
exec setpriv --reuid=65534 --regid=65534 --clear-groups --inh-caps=-all --no-new-privs \
    node /e2e/tcp-check.ts listen --name engine-host $ENGINE_HOST_PORTS
