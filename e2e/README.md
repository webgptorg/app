# @ptbk/e2e

Browser end-to-end tests: Chromium, inside a Docker Compose stack, through the relays to the mock engine.

```sh
bun run --filter @ptbk/e2e e2e                     # every scenario: build, start, test, stop
E2E_SCENARIO=nat bun run --filter @ptbk/e2e e2e    # one scenario
```

How the stack is built, how to debug it and where the logs go: [docs/development.md](../docs/development.md#end-to-end).

- `compose.yaml`: the base stack; `compose.<name>.yaml` overlays add to it. `src/scenarios.ts` says which overlays and specs make up each scenario (`E2E_SCENARIO`); `E2E_OVERLAYS` adds more.
- `gateway/gateway.sh`: the engine LAN's NAT and firewall rules (X-02); `proxy/` and `mitmproxy/`: the two proxies' configuration.
- `docker/stack.Dockerfile`: every image, one target each; `docker/playwright-entrypoint.sh` trusts the dev CA in Chromium; `docker/engine-host.sh` sets up the engine's network namespace.
- `init/generate.ts`: the one-shot provisioning (engine key, dev CA, relay certificates, static registry).
- `coredns/Corefile`: the test domains.
- `src/`: the host-side driver (`cli.ts`), Playwright fixtures, compose control, certificate helpers, the healthcheck probe, the shared topology (`stack.ts`), TCP reachability (`tcp-check.ts`), the packet-capture analyser (`pcap/`) and the relay key scan (`key-scan/`). Helpers have Vitest tests (`bun run --filter @ptbk/e2e test`), which never need Docker.
- `tests/`: Playwright specs (`*.spec.ts`), by scenario.
