# X-08. The dev stack and e2e side by side

- **Lane:** X · **Module:** `e2e/` · **Milestone:** M3
- **Depends on:** X-06
- **Status:** in progress (feat/x-08-dev-stack-address-space)
- **Spec:** none (developer tooling); ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

The local dev stack (`bun run dev:stack up`, project `ptbk-dev`) and any e2e scenario run on the same Docker host at the same time, so a person can keep clicking through the product while agents run the e2e suite to merge their PRs.

## Context

X-06 layered the dev stack over the e2e stack's own compose files, which pin the stack network to `10.89.231.0/24` and give services static addresses on it (relays, resolver, release store, dashboard, mock engine). Docker refuses a second network with an overlapping subnet, so `e2e` fails with "Pool overlaps with other one on this address space" whenever the dev stack runs, and docs/development.md tells people to stop the dev stack first. With a person giving product feedback on the dev stack and several agents running e2e, that no longer works.

Everything else already differs per project: compose project names (`ptbk-dev`, `ptbk-e2e-<checkout>`), volumes, networks and images are prefixed with them; e2e publishes no host port (only the opt-in `debug` overlay); the playwright run container is named after the project; the host resolver (`dev:trust`, 127.0.0.1:1053) only serves the host, and e2e containers resolve through their own CoreDNS. Only the address space collides.

I-07 (#82) changes how CoreDNS serves the engine domain (zone files in `coredns/zones/`, written by a `relay-dns` stand-in in the nat scenario); this task must keep working whichever of the two merges first.

## Scope

- The stack network's prefix becomes a compose variable, `PTBK_STACK_NET`, defaulting to the e2e value `10.89.231`, in every file the dev stack layers (`compose.yaml`, `compose.dashboard.yaml`): the subnet, its dynamic range, every `ipv4_address`, every `dns:` entry and every address in an environment variable or healthcheck. e2e sets nothing and runs exactly as before.
- `dev:stack` sets `PTBK_STACK_NET=10.89.241` for every compose call.
- The stack's CoreDNS config for the dev stack is rendered, not hand-kept: `dev:stack up` writes `coredns/` (the Corefile and any zone files) into `.dev/coredns/` (git-ignored) with the e2e prefix swapped for the dev one, and `compose.dev.yaml` mounts that directory over the resolver's `/etc/coredns`.
- The dev dashboard keeps the production heartbeat timing (offline after 3 missed 60 s heartbeats plus 15 s) instead of e2e's 15 s one, so an engine on the production cadence, such as the real engine, stays online without a dev-only setting. The mock engine keeps beating every 15 s.
- A unit test proves that no address the dev stack's compose config or rendered DNS config uses lies in any e2e network (`10.89.231.0/24` and the nat scenarios' engine LAN `10.89.232.0/24`), and that the e2e config is unchanged by the variable.
- `dev:stack up` against a `ptbk-dev` stack still on the old subnet says to run `bun run dev:stack down` first instead of failing obscurely.
- docs/development.md: the dev stack's address space, and the troubleshooting line telling people to stop the dev stack before e2e removed.

## Out of scope

- Several e2e scenarios at once on one host: e2e stacks still share their fixed addresses, which the Playwright tests also use (`src/stack.ts`).
- The engine LAN of the nat scenarios: the dev stack never layers those overlays.
- `dev:trust`, the dev CA, the test domains and the host's published ports: unchanged, so a machine that trusted the dev stack keeps trusting it.

## Design notes

- Compose interpolation (`${PTBK_STACK_NET:-10.89.231}.11`) keeps one service definition for both stacks, as X-06 asks ("reuse, don't fork").
- CoreDNS's own `{$VAR}` substitution would cover the Corefile but not zone files, which I-07 introduces; rendering the whole directory covers both, with the e2e files as the only source.
- Moving an existing `ptbk-dev` onto the new subnet needs `dev:stack down` and `up` once; the named volumes, and so the account, passkeys and linked engine, stay.

## Acceptance criteria

- [ ] `e2e/src/address-space.test.ts` (or similar) fails if any dev stack address falls into an e2e network.
- [ ] An e2e scenario passes while a dev stack runs on the same Docker host (recorded in the PR).
- [ ] The e2e compose config with no variable set is identical to before (recorded in the PR).
- [ ] `bun run dev:trust --dry-run` on a trusted machine still has nothing to do.
- [ ] A test fails if the dev overlay sets its own heartbeat timing again.
- [ ] docs/development.md updated.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Some Docker hosts (OrbStack) route between bridges; with distinct subnets the dev and e2e stacks still never share an address, and each container resolves test names only through its own stack's CoreDNS.
