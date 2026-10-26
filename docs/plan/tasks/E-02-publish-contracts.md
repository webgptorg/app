# E-02. Move the contracts public and consume published versions

- **Lane:** Engine integration · **Module:** `packages/protocol`, `packages/engine-api`, `packages/conformance`, `docs/engine-integration/`, every `package.json` that depends on them · **Milestone:** M5
- **Depends on:** C-05, E-01
- **Status:** todo
- **Spec:** Build plan (One source for contracts), Transparency and verifiability (1. Open source), Security hardening 10, Decisions (Contracts package open question); ADRs: [0002](../../adr/0002-public-private-split.md)

## Goal

The three contract packages and the integration guide live in a public repository and are published to npm with provenance; this repo consumes them as pinned npm versions and no longer contains its own copy.

## Context

ADR 0002: contracts start here so they can iterate with the relay and mock engine, and move public before the real engine depends on them, with one source of truth and never two copies. Customers must be able to audit the protocol their engine speaks. npm provenance can only be generated from a public repository, so publishing from this private repo is not an option for the provenance requirement.

## Scope

- Repository boundary: agents work only in `webgptorg/app`. They never push to, open pull requests in or file issues on `webgptorg/promptbook` or any other repository; every step in the destination repository is done by a human. Until Seb starts this task, the contracts and the integration guide stay in this repository only (2026-10-21). Agents prepare the material here: the extraction script, the destination's workflow files and the consumer PR.
- Agree with the engine team (human decision, record it in a new ADR that supersedes ADR 0002; ADR 0002 itself is not edited): destination (`webgptorg/promptbook` monorepo `packages/` or a separate public repo), npm scope and package names, and the moment of the move.
- In the destination: copy `packages/protocol`, `packages/engine-api`, `packages/conformance` and `docs/engine-integration/` with git history if practical (`git filter-repo`), keep MIT licences, keep tests and golden vectors, and keep their CI green there.
- Release workflow in the destination: npm trusted publishing (OIDC, no long-lived npm token), `--provenance`, a protected environment with a second maintainer's approval, SHA-pinned actions, read-only default permissions, no caches, no `pull_request_target` (spec, Security hardening 10). Packages use SemVer; message versions (`v1`, `v2`) stay independent of package versions.
- Changelog per package. A breaking contract change is a major version and ships `v2` messages beside `v1`.
- In this repo, one PR: replace `"workspace:*"` with exact published versions in every consumer (`apps/relay`, `apps/dashboard`, `apps/mock-engine`, `apps/engine-ui`), delete the three package directories and `docs/engine-integration/` (leave a short pointer in `docs/architecture.md`), update ESLint blocks that target `packages/protocol|engine-api|conformance`, update `docs/architecture.md` and `AGENTS.md`, set ADR 0002's status to `Superseded by NNNN` (the only change to it; its text stays, per the ADR process), and point the conformance CI job at the published CLI.
- Supply-chain fit: `bunfig.toml` refuses versions younger than 7 days. Decided 2026-10-19: exempt exactly our own npm scope from the 7-day minimum release age (our packages are built by our pipeline with provenance); record it in the ADR and keep the rule for everything else.
- Verify provenance in CI here: a step runs `npm audit signatures` (or equivalent) for the contract packages and fails on missing provenance.
- Document the cross-repo development loop: link a local checkout of the contracts into this repo for a change that touches both sides, then publish and bump.

## Out of scope

- Running conformance and e2e against the real engine (E-03). Publishing anything else (relay, dashboard, engine-ui stay private).

## Design notes

- Before the move, run a check that the packages contain no private references: no `@ptbk/*` imports outside the three packages, no internal hostnames, no fixtures with real data, licence headers present. ESLint already blocks platform and `@ptbk/*` imports in `protocol` and `engine-api`; C-05 extends it to `conformance`.
- Rename the workspace scope `@ptbk/*` to the chosen public scope in the same change, so imports change once.
- Dependabot here picks up new contract versions. Its 7-day cooldown must exempt our own scope too (`cooldown.exclude`), matching the `bunfig.toml` exemption, or contract bumps wait a week.

## Acceptance criteria

- [ ] The packages are published from the public repo; `npm view <pkg> --json` shows provenance attestations linked to the public workflow run.
- [ ] Publishing without the second maintainer's approval is impossible (protected environment; tested once with a dry run).
- [ ] This repo contains no copy of the contract sources; `grep -r "workspace:\*"` finds no contract package.
- [ ] `bun install --frozen-lockfile` and `bun run check` pass here with the published versions; the e2e suite and the conformance job against the mock engine still pass.
- [ ] The integration guide is reachable publicly and its links work there.
- [ ] The new ADR (superseding ADR 0002) recording destination, names and the release-age decision, including the Dependabot exemption, is merged.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Package names, destination and timing are open (spec: "pick the moment and the package name with the engine team").
- Moving into the engine monorepo couples contract releases to its release process; a separate repo is simpler to publish but is one more repo to audit. List the trade-off in the ADR.
- A contract change during the move window lands in two places; freeze contract changes from the start of this task until the switch PR merges.
- Recommendations from E-04 for whoever runs the move (the engine maintainer decides whether and when; until then the engine consumes the contracts from a checkout of this repository, which is the supported path):
  - Give each package a `version` and publish a built `dist` (JavaScript plus declarations) next to the TypeScript source. Today the packages have no version and export source with extensionless imports, so they cannot be packed, and plain `node` cannot load them.
  - Move `@ptbk/release-tools` with the three contract packages. It holds the Sigstore provenance adapter and the pinned trusted root that the engine's UI loader should reuse rather than reimplement, and it is already MIT and imports only `@ptbk/protocol`.
