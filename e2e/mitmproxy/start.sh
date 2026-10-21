#!/bin/sh
# mitmproxy as a TLS-inspecting corporate proxy (X-02). Root only long enough to hand the shared volume to the
# mitmproxy user; the proxy itself runs unprivileged. Its CA key stays in the container's own config directory; only
# the certificate is copied to the shared volume, for the engine to trust through NODE_EXTRA_CA_CERTS.
set -eu
chown mitmproxy:mitmproxy /mitm
exec gosu mitmproxy env HOME=/home/mitmproxy mitmdump \
    --mode regular@8080 \
    --set ssl_verify_upstream_trusted_ca=/pki/ca-cert.pem \
    --set flow_detail=0 \
    -s /e2e-mitm/record_websockets.py
