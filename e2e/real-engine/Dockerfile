# The real engine for the dev stack (`bun run dev:stack up --no-system --engine real`, compose.real-engine.yaml): the
# conformance build of ptbk from a checkout of webgptorg/promptbook (the `engine` build context, PTBK_ENGINE_DIR).
# Only the conformance build trusts the stack's re-signed UI release (PTBK_CONFORMANCE_TRUST_FILE) and serves its
# own certificate from a development CA, so it is the one that works without the internet. The build itself downloads
# the engine's npm dependencies; the running container has no way out (compose.real-engine.yaml).
#
# Copied file by file, so a checkout's own node_modules/, dist/ or .git/ never reach the image.

ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS build
WORKDIR /opt/ptbk
COPY --from=engine package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY --from=engine src src
COPY --from=engine scripts scripts
COPY --from=engine specs specs
COPY --from=engine bin bin
COPY --from=engine design/brand/fonts design/brand/fonts
# The engine starts its background services from <root>/dist (engineModule), so the conformance build goes there:
# otherwise every daemon it launches would run the release build, which refuses the conformance trust file.
RUN npm run build:conformance && rm -rf dist && mv dist-conformance dist && npm prune --omit=dev

FROM ${NODE_IMAGE}
# git: the engine commits its setup; ca-certificates: Node's own roots plus the dev CA from NODE_EXTRA_CA_CERTS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system user.name 'Local stack engine' \
    && git config --system user.email 'engine@engine.test' \
    && git config --system init.defaultBranch main \
    && printf '#!/bin/sh\nexec node /opt/ptbk/bin/ptbk.js "$@"\n' > /usr/local/bin/ptbk \
    && chmod 755 /usr/local/bin/ptbk
COPY --from=build /opt/ptbk/package.json /opt/ptbk/package.json
COPY --from=build /opt/ptbk/node_modules /opt/ptbk/node_modules
COPY --from=build /opt/ptbk/bin /opt/ptbk/bin
COPY --from=build /opt/ptbk/dist /opt/ptbk/dist
COPY --from=build /opt/ptbk/specs /opt/ptbk/specs
USER node
WORKDIR /home/node
