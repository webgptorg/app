# The load test's two images (R-05): the relay exactly as R-02 builds it for production, and the generator, which runs
# the load scripts from source with tsx. Build context is the repo root. Base images are the e2e stack's, pinned by
# digest; bump them together with e2e/docker/stack.Dockerfile.

ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG BUN_IMAGE=oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288

FROM ${BUN_IMAGE} AS bun

# Only the files `bun install` reads, so source edits keep the install layer cached.
FROM ${NODE_IMAGE} AS manifests
COPY . /src
RUN find /src -type f ! -name package.json ! -name bun.lock ! -name bunfig.toml -delete \
    && find /src -depth -type d -empty -delete

FROM ${NODE_IMAGE} AS builder
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY --from=manifests /src/ ./
RUN bun install --frozen-lockfile --filter @ptbk/relay
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/relay apps/relay
RUN bun run --filter @ptbk/relay build

FROM ${NODE_IMAGE} AS relay
COPY --from=builder /repo/apps/relay/dist/ /app/
COPY apps/relay/load/relay-probe.mts apps/relay/load/healthcheck.mts /load/
USER node
CMD ["node", "--enable-source-maps", "/app/main.mjs"]

FROM builder AS generator
WORKDIR /repo/apps/relay
ENTRYPOINT ["node_modules/.bin/tsx"]
