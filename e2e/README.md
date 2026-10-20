# @ptbk/e2e

Browser end-to-end tests: Chromium, inside a Docker Compose stack, through the relays to the mock engine.

```sh
bun run --filter @ptbk/e2e e2e     # build, start, test, stop
```

How the stack is built, how to debug it and where the logs go: [docs/development.md](../docs/development.md#end-to-end).

- `compose.yaml`: the base stack; `compose.<scenario>.yaml` overlays add to it (`E2E_OVERLAYS`).
- `docker/stack.Dockerfile`: every image, one target each; `docker/playwright-entrypoint.sh` trusts the dev CA in Chromium.
- `init/generate.ts`: the one-shot provisioning (engine key, dev CA, relay certificates, static registry).
- `coredns/Corefile`: the test domains.
- `src/`: the host-side driver (`cli.ts`), Playwright fixtures, compose control, certificate helpers, the healthcheck probe and the shared topology (`stack.ts`). Helpers have Vitest tests (`bun run --filter @ptbk/e2e test`), which never need Docker.
- `tests/`: Playwright specs (`*.spec.ts`), by scenario.
