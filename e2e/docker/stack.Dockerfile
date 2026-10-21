# Every image of the e2e stack, one target each, so they share one install and one build. Base images are pinned by
# digest (multi-arch index, looked up with `docker buildx imagetools inspect`); bump the tag and digest together.

ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG BUN_IMAGE=oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
ARG PEBBLE_IMAGE=ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

FROM ${BUN_IMAGE} AS bun

# Only for its minica certificate, the root of Pebble's own HTTPS listeners (init publishes it; acme scenario).
FROM ${PEBBLE_IMAGE} AS pebble

# Only the files `bun install` reads. Source edits leave this stage's output unchanged, so the install layers below
# stay cached while you iterate.
FROM ${NODE_IMAGE} AS manifests
COPY . /src
RUN find /src -type f ! -name package.json ! -name bun.lock ! -name bunfig.toml -delete \
    && find /src -depth -type d -empty -delete

FROM ${NODE_IMAGE} AS builder
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY --from=manifests /src/ ./
RUN bun install --frozen-lockfile --filter @ptbk/relay --filter @ptbk/mock-engine
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/engine-api packages/engine-api
COPY packages/release-tools packages/release-tools
COPY apps/relay apps/relay
COPY apps/mock-engine apps/mock-engine
RUN bun run --filter @ptbk/relay build && bun run --filter @ptbk/mock-engine build

# engine-ui packed with X-03's own `pack`, twice: the bundle the loader installs and the one init tampers with (M-05).
# The build context is not a git checkout, so the commit is a placeholder and SOURCE_DATE_EPOCH is 0.
FROM ${NODE_IMAGE} AS ui-bundle
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY --from=manifests /src/ ./
RUN bun install --frozen-lockfile --filter @ptbk/engine-ui
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/engine-api packages/engine-api
COPY packages/ui packages/ui
COPY packages/release-tools packages/release-tools
COPY apps/engine-ui apps/engine-ui
WORKDIR /repo/apps/engine-ui
RUN bun run generate \
    && for version in 0.0.0-dryrun.1 0.0.0-dryrun.2; do \
        node_modules/.bin/tsx scripts/pack.ts --tag "ui-v${version}" \
            --commit 0000000000000000000000000000000000e2e000 --source-date-epoch 0 \
        && mkdir -p "/ui-bundles/${version}" \
        && cp release/engine-ui.tar.zst release/manifest.json "/ui-bundles/${version}/" \
        || exit 1; \
    done

# One-shot: runs the mock engine's own identity, dev-ca and ui-test-release CLIs from source, so it needs the full
# builder, plus the packed UI bundles to sign and publish.
FROM builder AS init
COPY --from=ui-bundle /ui-bundles /ui-bundles
COPY --from=pebble /test/certs/pebble.minica.pem /pebble/minica.pem
COPY e2e/src/stack.ts e2e/src/stack.ts
COPY e2e/init e2e/init
CMD ["node", "e2e/init/generate.ts"]

FROM ${NODE_IMAGE} AS relay
COPY --from=builder /repo/apps/relay/dist/ /app/
COPY e2e/src/probe.ts /e2e/probe.ts
USER node
CMD ["node", "--enable-source-maps", "/app/main.mjs"]

FROM ${NODE_IMAGE} AS mock-engine
COPY --from=builder /repo/apps/mock-engine/dist/ /app/
COPY e2e/src/probe.ts /e2e/probe.ts
USER node
CMD ["node", "--enable-source-maps", "/app/main.mjs"]

# X-02's network helpers: the gateway (iptables), the network namespaces of the engine host and the relays, the packet
# capture (tcpdump) and the engine probe, all from one image. Debian keeps only the current version of a package in
# bookworm, so these pins fail the build loudly once it moves on: bump them together with NODE_IMAGE.
FROM ${NODE_IMAGE} AS nettools
RUN apt-get update \
    && apt-get install -y --no-install-recommends iptables=1.8.9-2 iproute2=6.1.0-3 tcpdump=4.99.3-1 \
    && rm -rf /var/lib/apt/lists/*
# The relay-a capture runs as nobody with only this file capability (and NET_RAW in its bounding set), not as root;
# /captures seeds the capture volume with an owner that may write to it.
RUN setcap cap_net_raw=ep /usr/bin/tcpdump && install -d -o 65534 -g 65534 /captures
COPY e2e/src/probe.ts e2e/src/tcp-check.ts /e2e/
COPY e2e/gateway/gateway.sh e2e/docker/engine-host.sh /e2e/

# The connect-proxy scenario's corporate forward proxy (X-02): tinyproxy, which logs each CONNECT when it starts (Squid
# logs a tunnel only once it closes, too late for a test that checks the open tunnels). Same pinning as nettools.
FROM ${NODE_IMAGE} AS connect-proxy
RUN apt-get update \
    && apt-get install -y --no-install-recommends tinyproxy-bin=1.11.1-2.1+deb12u1 \
    && rm -rf /var/lib/apt/lists/*
COPY e2e/proxy/tinyproxy.conf /etc/tinyproxy.conf
USER nobody
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy.conf"]

FROM ${NODE_IMAGE} AS release-store
COPY e2e/src/release-store.ts /e2e/release-store.ts
USER node

# The official image already holds the browsers for this exact @playwright/test version; nothing is downloaded at
# install time (no install scripts) or at run time.
FROM ${PLAYWRIGHT_IMAGE} AS playwright
# Exactly the version of the image's own libnss3, which libnss3-tools requires. Ubuntu keeps only the newest
# version in noble-updates, so once it ships a newer NSS this pin fails the build loudly: bump the image digest and
# this version together.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libnss3-tools=2:3.98-1ubuntu0.2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY --from=manifests /src/ ./
RUN bun install --frozen-lockfile --filter @ptbk/e2e
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY e2e e2e
# Tests run as pwuser, which owns nothing else in the tree.
RUN install -d -o pwuser -g pwuser /repo/e2e/test-results
WORKDIR /repo/e2e
USER pwuser
ENTRYPOINT ["/repo/e2e/docker/playwright-entrypoint.sh"]
CMD ["node_modules/.bin/playwright", "test"]
