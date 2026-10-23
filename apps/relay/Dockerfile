# The production relay image (I-03): built by release-relay.yml from the repository root with no cache, pushed to
# GHCR by digest and signed keylessly; relay hosts run it with rootful Podman as uid 10001 (infra/relay).
# Both stages use the same Node base, pinned by digest; Bun only installs and runs the build.

FROM docker.io/oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS bun

FROM docker.io/library/node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
# Every workspace manifest, so the frozen lockfile matches; then only the relay's own dependencies, without
# lifecycle scripts (the relay needs none).
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/engine-ui/package.json apps/engine-ui/
COPY apps/mock-engine/package.json apps/mock-engine/
COPY apps/relay/package.json apps/relay/
COPY packages/conformance/package.json packages/conformance/
COPY packages/engine-api/package.json packages/engine-api/
COPY packages/protocol/package.json packages/protocol/
COPY packages/release-tools/package.json packages/release-tools/
COPY packages/ui/package.json packages/ui/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile --ignore-scripts --filter @ptbk/relay
COPY packages/protocol/src packages/protocol/src
COPY apps/relay/tsconfig.json apps/relay/tsdown.config.ts apps/relay/
COPY apps/relay/src apps/relay/src
RUN bun run --filter @ptbk/relay build

FROM docker.io/library/node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c
# One self-contained file: the relay needs no node_modules at runtime (tsdown.config.ts).
COPY --from=build /src/apps/relay/dist/main.mjs /app/main.mjs
USER 10001:10001
ENTRYPOINT ["node", "/app/main.mjs"]
