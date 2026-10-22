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
- `init/generate.ts`: the one-shot provisioning (engine key, dev CA, relay and release store certificates, static registry, signed UI releases and their trust policy).
- `coredns/Corefile`: the test domains.
- `src/`: the host-side driver (`cli.ts`), Playwright fixtures, compose control, certificate helpers, the healthcheck probe, the release store's static server (`release-store.ts`), the shared topology (`stack.ts`), TCP reachability (`tcp-check.ts`), the packet-capture analyser (`pcap/`) and the relay key scan (`key-scan/`). Helpers have Vitest tests (`bun run --filter @ptbk/e2e test`), which never need Docker.
- The base stack includes the UI loader (M-05): the `ui-bundle` image stage packs engine-ui twice with X-03's `pack`, init signs both with release keys that exist only while it runs (the mock engine's `ui-test-release` CLI, test attestations instead of Sigstore) and publishes them to `release-store` (`https://releases.ptbk.test/`), where the second one's archive is tampered with after signing. The mock engine installs the first (pinned), serves it at `/` behind the gateway, and keeps it when `tests/ui-loader/` publishes the tampered one through its control listener (`10.89.231.31:4480`). The spike page is at `/__spike/`.
- `compose.dashboard.yaml` and `dashboard/` (X-05): the dashboard as the registry, its relay keys minted by `dashboard/mint-registry-keys.sh`, and the mock engine on demand; `src/dashboard.ts` has the scenario's fixtures ([docs/development.md](../docs/development.md#the-dashboard-flow)).
- `compose.dev.yaml`, `coredns/Corefile.host`, `src/dev-stack*.ts`, `src/dev-trust.ts` (X-06): the local dev stack behind `bun run dev:stack`, `dev:link`, `dev:trust` and `dev:untrust` (compose project `ptbk-dev`, state kept across `down`, the persistent dev CA in `.dev/pki/`); `playwright.dev.config.ts` and `tests/dev-stack/` its smoke test, run on the host with `bun run --filter @ptbk/e2e dev:smoke` ([docs/development.md](../docs/development.md#local-stack)).
- `tests/`: Playwright specs (`*.spec.ts`), by scenario.
