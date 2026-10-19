# I-03. Deploy and release pipelines

- **Lane:** I · **Module:** `.github/workflows`, `infra/relay` (deploy script), `apps/relay/Dockerfile` if missing · **Milestone:** M4
- **Depends on:** I-01, I-02, X-03
- **Status:** todo
- **Spec:** Security hardening item 10; Hosting and stack (Releases; Release artifacts; Engine UI bundle); Residual risks (Release keys and dependencies); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

Every deploy and release goes through a GitHub Actions workflow that one stolen token cannot poison: the dashboard deploys with wrangler behind environment approvals, the relay ships as a cosign-signed container image rolled out one relay at a time, and the engine-ui bundle release from X-03 needs a second maintainer's approval.

## Context

The engine UI bundle runs on customers' engines and sees decrypted data, so its release path is the main way to reach customer data (ADR 0003). The relay and dashboard see no content but carry availability and metadata. The spec's rule: SHA-pinned actions, read-only default tokens, no `pull_request_target`, no restored caches, keyless cosign signing, and no release without a second maintainer. `docs/development.md` lists the CI rules this repo already follows; zizmor audits every workflow in CI.

## Scope

- GitHub environments: `staging` (deploys from `main` only), `production` and `release` (required reviewers, "prevent self-review" on, deploys from `main` only). Secrets live in environments, never at repository level.
- `deploy-dashboard.yml`: on push to `main`, job `staging` builds with `CLOUDFLARE_ENV=staging`, runs `wrangler d1 migrations apply DB --env staging --remote`, then `wrangler deploy --env staging` (Worker and SPA assets in one upload), then smoke-tests `/v1/health` and that `/` serves the SPA shell with its CSP. Job `production` needs `staging`, waits for approval, rebuilds the same commit with `CLOUDFLARE_ENV=production` (the Vite plugin bakes the environment in at build time), applies migrations, deploys and smoke-tests. Uses I-02's per-environment deploy token. Application secrets (Stripe, relay tokens) are set by humans with `wrangler secret put` and documented, not carried by CI.
- `release-relay.yml`: on push to `main` touching `apps/relay` or `packages/protocol`, or manual dispatch:
  - build `apps/relay/Dockerfile` (multi-stage, Node 24 base pinned by digest, non-root user, no build cache), push to `ghcr.io/webgptorg/relay` by digest;
  - sign keylessly with cosign (`id-token: write` in this job only), attach an SBOM and a build provenance attestation;
  - deploy to staging relays, then (after `production` approval) to production relays, strictly one host at a time: SSH with the forced-command deploy key from I-01, which pulls the digest, runs `cosign verify` on the host against the expected workflow identity and issuer, swaps the systemd unit to the new digest and restarts. Wait until the relay answers on its own hostname and its tunnel count recovers (engines reconnect within 10 s per the spike criteria; time out at 60 s) before the next host; on failure stop, roll that host back to the previous digest and fail the job.
- Engine-ui release: X-03 owns `.github/workflows/ui-release.yml` (build, sign, publish); I-03 wires its deployment and approvals: the `release` environment gate and an R2 token scoped to the release bucket only. Do not duplicate the workflow.
- Rollback: `workflow_dispatch` input `digest` on `release-relay.yml` (must be a digest signed by our workflow); dashboard rollback documented with `wrangler rollback`.
- `docs/runbooks/deploy.md`: approvals, rollback, rotating each token, what to do if a token leaks.

## Out of scope

- The key ceremony for the release key (human-held, hardware key) and the three maintainer keys (2 of 3 for security releases): a human decision in the plan's "Still needed" table, owned by neither I-03 nor X-03.
- Engine releases (public repo); hosts and DNS (I-01, I-02).

## Design notes

- Every workflow: `permissions: {}` at top and minimal per job (`contents: read`; `packages: write` only for push; `id-token: write` and `attestations: write` only for signing), `persist-credentials: false`, actions pinned to full SHAs, untrusted values through `env`, `timeout-minutes` set, `concurrency` per environment without cancelling a running deploy.
- No `actions/cache`, no `cache:` inputs on setup actions, no Docker layer cache from the registry or GHA.
- D1 migrations are the committed drizzle-kit output ([ADR 0009](../../adr/0009-drizzle-and-migrations.md)); the pipeline applies them only with `wrangler d1 migrations apply` and never runs `drizzle-kit push` or `migrate` against a remote database. They must be backward compatible with the currently deployed code (expand, deploy, then contract in a later PR), because migration and deploy are not atomic and `wrangler rollback` does not undo a migration. D-01's drift and destructive-change guards (a contract step carries a `-- contract:` marker) are part of `bun run check`, which CI runs as one step before any deploy job. D-01 states the rule in `apps/dashboard/README.md`; link it from the runbook.
- The host-side cosign check means a leaked deploy key can only deploy images our workflow signed.
- GHCR pull access from hosts: a read-only token placed by I-01's secret mechanism, or a public image if the team accepts that the relay image is visible (it contains no secrets but is commercial code).

## Acceptance criteria

- [ ] zizmor passes with no findings at medium or above on all new workflows.
- [ ] A push to `main` deploys the dashboard to staging; production waits for an approver who is not the pusher (screenshot or run link in the PR).
- [ ] A relay release produces a signed image; `cosign verify` with the expected identity succeeds, and an unsigned or differently signed image is refused by the host script (tested on staging).
- [ ] Rolling deploy across two relays (staging can temporarily run two) keeps a browser connection test passing throughout; a deliberately broken image stops the rollout after the first host and rolls it back.
- [ ] The UI release cannot publish without `release` approval by a second maintainer.
- [ ] Runbook written; `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Cloudflare has no OIDC federation for wrangler, so the deploy token is a long-lived secret; keep it environment-scoped and rotated.
- SSH from GitHub-hosted runners means the allowlist cannot be tight; the forced command and host-side signature check are the mitigation. A pull-based deploy is the alternative if the team prefers.
- Release key holders and the key ceremony are a pending human decision (plan's "Still needed" table); production UI signing waits on it.
