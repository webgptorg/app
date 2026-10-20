# Every image of the e2e stack, one target each, so they share one install and one build. Base images are pinned by
# digest (multi-arch index, looked up with `docker buildx imagetools inspect`); bump the tag and digest together.

ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG BUN_IMAGE=oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

FROM ${BUN_IMAGE} AS bun

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
COPY apps/relay apps/relay
COPY apps/mock-engine apps/mock-engine
RUN bun run --filter @ptbk/relay build && bun run --filter @ptbk/mock-engine build

# One-shot: runs the mock engine's own identity and dev-ca CLIs from source, so it needs the full builder.
FROM builder AS init
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

# The official image already holds the browsers for this exact @playwright/test version; nothing is downloaded at
# install time (no install scripts) or at run time.
FROM ${PLAYWRIGHT_IMAGE} AS playwright
RUN apt-get update \
    && apt-get install -y --no-install-recommends libnss3-tools \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
COPY --from=manifests /src/ ./
RUN bun install --frozen-lockfile --filter @ptbk/e2e
COPY tsconfig.base.json ./
COPY e2e e2e
WORKDIR /repo/e2e
ENTRYPOINT ["/repo/e2e/docker/playwright-entrypoint.sh"]
CMD ["node_modules/.bin/playwright", "test"]
