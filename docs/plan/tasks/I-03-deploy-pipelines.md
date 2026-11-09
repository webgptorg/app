# I-03. Deploy and release pipelines

- **Lane:** I · **Module:** `.github/workflows`, `infra/relay` (deploy script), `apps/relay/Dockerfile` if missing · **Milestone:** M4
- **Depends on:** I-01, I-02, X-03
- **Status:** done (#78)
- **Spec:** Security hardening item 10; Hosting and stack (Releases; Release artifacts; Engine UI bundle); Residual risks (Release keys and dependencies); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0014](../../adr/0014-cryptography.md)

## Goal

Every deploy and release goes through a GitHub Actions workflow that one stolen token cannot poison: the dashboard deploys with wrangler behind environment approvals, the relay ships as a cosign-signed container image rolled out one relay at a time, and the engine-ui bundle release from X-03 needs a second maintainer's approval.

## Context

The engine UI bundle runs on customers' engines and sees decrypted data, so its release path is the main way to reach customer data (ADR 0003). The relay and dashboard see no content but carry availability and metadata. The spec's rule: SHA-pinned actions, read-only default tokens, no `pull_request_target`, no restored caches, keyless cosign signing, and no release without a second maintainer. `docs/development.md` lists the CI rules this repo already follows; zizmor audits every workflow in CI.

## Scope

- GitHub environments: `staging` (deploys from `main` only), `production` and `release` (required reviewers, "prevent self-review" on, deploys from `main` only). Secrets live in environments, never at repository level.
- `deploy-dashboard.yml`: on push to `main`, job `staging` builds with `CLOUDFLARE_ENV=staging`, runs `wrangler d1 migrations apply DB --env staging --remote`, then `wrangler deploy --env staging` (Worker and SPA assets in one upload), then smoke-tests `/v1/health` and that `/` serves the SPA shell with its CSP. Job `production` needs `staging`, waits for approval, rebuilds the same commit with `CLOUDFLARE_ENV=production` (the Vite plugin bakes the environment in at build time), applies migrations, deploys and smoke-tests. Uses I-02's per-environment deploy token. Application secrets (Stripe, relay tokens) are set by humans with `wrangler secret put` and documented, not carried by CI.
- `release-relay.yml`: on push to `main` touching `apps/relay` or `packages/protocol`, or manual dispatch:
  - build `apps/relay/Dockerfile` (multi-stage, Node 24 base pinned by digest, non-root user, no build cache), push to `ghcr.io/webgptorg/relay` by digest;
  - sign keylessly with cosign (`id-token: write` in this job only) with a Rekor entry and an RFC 3161 TSA timestamp (`--timestamp-server-url`), attach an SBOM and a build provenance attestation;
  - deploy to staging relays, then (after `production` approval) to production relays, strictly one host at a time, **pull-based** (see Decisions): the job moves that relay's GHCR tag (`deploy-<relay hostname>`) to the signed digest. On the host, a systemd timer and a sandboxed oneshot unit resolve the tag with a read-only token, run `cosign verify` with the exact identity (ADR 0014): `--certificate-identity https://github.com/webgptorg/app/.github/workflows/release-relay.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-github-workflow-repository webgptorg/app` and a required timestamp, never `--certificate-identity-regexp`, refuse a downgrade (below), swap the systemd unit to the new digest and restart, then wait until the relay answers on its own hostname and its tunnel count recovers (engines reconnect within 10 s per the spike criteria; time out at 60 s), and roll themselves back otherwise. The job polls the relay's `/healthz` from outside until it reports the new digest through the relay's window (timer interval plus 60 s); on timeout it moves the tag back, stops and fails.
  - downgrade guard: a host refuses an image built more than N days (default 30, configurable) before the newest image it ever ran (a persisted, root-owned high-water mark), or before an optional `PTBK_DEPLOY_MIN_CREATED` floor that covers a fresh or rebuilt host, and refuses an image without a build time; the previous image and digests in a root-owned local override file are exempt. Only such verdicts are remembered as refused: registry, Sigstore or DNS outages fail the run and the next one retries.
- Engine-ui release: X-03 owns `.github/workflows/ui-release.yml` (build, sign, publish); I-03 wires its deployment and approvals: the `release` environment gate and an R2 token scoped to the release bucket only. Do not duplicate the workflow, but check it signs as M-05 verifies: `sigstore.attest()` over the release entry's DSSE envelope with `tsaServerURL` set, so the bundle carries the TSA timestamp the loader requires as trusted time, from a GitHub-hosted runner on a `refs/tags/` ref, with the pinned `trusted_root.json` published next to the release.
- Rollback: `workflow_dispatch` input `digest` on `release-relay.yml` (must be a digest signed by our workflow; it moves the tags); dashboard rollback documented with `wrangler rollback`.
- `docs/runbooks/deploy.md`: approvals, rollback, rotating each token, what to do if a token leaks.

## Out of scope

- The key ceremony for the release key (human-held, hardware key) and the three maintainer keys (2 of 3 for security releases): a human decision in the plan's "Still needed" table, owned by neither I-03 nor X-03.
- Engine releases (public repo); hosts and DNS (I-01, I-02).

## Design notes

- Every workflow: `permissions: {}` at top and minimal per job (`contents: read`; `packages: write` only for push; `id-token: write` and `attestations: write` only for signing), `persist-credentials: false`, actions pinned to full SHAs, untrusted values through `env`, `timeout-minutes` set, `concurrency` per environment without cancelling a running deploy.
- No `actions/cache`, no `cache:` inputs on setup actions, no Docker layer cache from the registry or GHA.
- D1 migrations are the committed drizzle-kit output ([ADR 0009](../../adr/0009-drizzle-and-migrations.md)); the pipeline applies them only with `wrangler d1 migrations apply` and never runs `drizzle-kit push` or `migrate` against a remote database. They must be backward compatible with the currently deployed code (expand, deploy, then contract in a later PR), because migration and deploy are not atomic and `wrangler rollback` does not undo a migration. D-01's drift and destructive-change guards (a contract step carries a `-- contract:` marker) are part of `bun run check`, which CI runs as one step before any deploy job. D-01 states the rule in `apps/dashboard/README.md`; link it from the runbook.
- The host-side cosign check and the downgrade guard mean that whoever can move a tag can only choose among recent images our workflow signed.
- GHCR pull access from hosts: the image stays private, pulled with a read-only token placed by I-01's secret mechanism (`LoadCredential`). The token belongs to a dedicated machine account that can read only the relay package, never a person's (a classic `read:packages` token reads every package its owner can).

## Decisions

2026-10-23 (coordinator, delegated by Seb, on PR #78's open questions):

- **Pull-based relay deploys.** Pushing over SSH from GitHub-hosted runners would open port 22 to cloud-sized ranges and keep a long-lived SSH deploy key in GitHub; larger runners with fixed addresses need a paid plan, and a self-hosted runner is one more high-value host. Relays pull instead: no inbound deploy path, port 22 stays admins-only from the allowlist, and it works on the Free plan. The SSH deploy key, its forced command and the deploy user are removed (I-01's hook).
- **Downgrade guard** in this task, as above.
- **Private image**, pulled with a read-only token of a machine account through `LoadCredential`.
- **cosign on hosts** is the upstream release pinned by SHA-256 (as lego in I-01), bumped like any dependency.

2026-11-09 (Seb): the org stays on GitHub Free, so there are no environments and **no deploy secret goes into GitHub**. CI builds and signs keylessly with only `GITHUB_TOKEN` and OIDC and rolls the relays out; production relay rollouts need a dispatch with `production`, which is the approval. The dashboard deploy and the UI release's key signature and upload run from a maintainer's machine; their CI jobs stay, switched off by repository variables, for a paid plan ([deploy runbook, GitHub settings](../../runbooks/deploy.md#github-settings)).

## Acceptance criteria

The code lands before any credential exists; everything below is verifiable in CI without one.

- [x] zizmor passes with no findings at medium or above on all new workflows. (zizmor 1.30.1, offline and online, locally in #78 because GitHub Actions is down.)
- [x] `apps/relay/Dockerfile` builds in CI (non-root, base pinned by digest, no cache); `deploy-dashboard.yml` runs `wrangler deploy --dry-run --env staging` on PRs. (Both steps run locally in #78; `deploy-test.sh` builds the image from this Dockerfile.)
- [ ] `release-relay.yml` builds, pushes to GHCR with `GITHUB_TOKEN` and signs keylessly through GitHub OIDC with a TSA timestamp; `cosign verify` with the exact identity flags succeeds, and the host script refuses an unsigned image and one signed by another workflow, branch or repository (recorded Sigstore bundle fixtures for the other repository and workflow; a `workflow_dispatch` run from a branch for the other ref; no signing on pull request runs, which would need `id-token` and `packages` write there); no workflow or script uses `--certificate-identity-regexp`. (Host side done in #78: `deploy-test.sh` refuses unsigned, other repository, workflow, branch, issuer and untimestamped images with the real cosign, and the recorded Flux fixture; `tofu test` rejects `identity-regexp`. Open until the workflow's first run on `main`: the GHCR push, the keyless signature with its TSA timestamp, and the branch-dispatch refusal, because GitHub Actions is down.)
- [x] The host-side verify, swap and rollback works in a container standing in for a relay (I-01's files and units): a deliberately broken image is rolled back; the downgrade guard refuses an old signed image, and allows the previous image and one listed in the override file. (`deploy-test.sh`, which also covers the high-water mark, `PTBK_DEPLOY_MIN_CREATED`, an image without a build time and outages.)
- [x] Rolling deploy in CI across two containers standing in for two relays, with their tags in a local registry standing in for GHCR: a deliberately broken image stops the rollout after the first host, which rolls back while its tag is moved back; the second host is untouched. No deploy key or deploy user exists on a host (`verify.sh`). (`deploy-test.sh` locally in #78; `verify.sh` runs in I-01's VM test.)
- [x] Runbook written; `bun run check` passes.
- [x] **Status** line above set to `done (#<PR>)`.

## Apply (needs credentials)

Tracked in [apply.md](../apply.md). Needs a second maintainer account, I-02's `ptbk-<env>-deploy` token, the GHCR machine account and its read token on hosts, and I-01's and I-02's applied staging.

- A push to `main` rolls the relay out to staging; production relays only on a dispatch with `production`. A maintainer deploys the dashboard from their machine.
- Rolling deploy across two relays (staging can temporarily run two) keeps a browser connection test passing throughout; a deliberately broken image stops the rollout after the first host and rolls it back.
- A UI release is published only from a maintainer's machine; `ui-release.yml`'s `publish` job does not run without `UI_CI_PUBLISH`.

## Risks and open points

- Cloudflare has no OIDC federation for wrangler, so the deploy token is a long-lived secret; keep it in the maintainers' password manager and rotated.
- `packages: write` is not scoped to an environment, so any workflow run that grants it can move `deploy-*` tags. The host-side signature check and the high-water guard bound that to a denial of service (no unsigned code, no downgrade). Follow-up once environment secrets exist: move tags with a dedicated environment-scoped token.
- Relays report the image digest they run on `/healthz`; that discloses which signed release runs, nothing about engines. Tunnel counts stay on the host, so the pipeline waits out the host's window instead of reading them.
- **GitHub plan:** environments and environment secrets in a private organization repository need GitHub Team (Pro is for personal accounts), and required reviewers with "prevent self-review" need Enterprise; the org is on Free. Decided 2026-11-09: stay on Free (Decisions).
- Release key holders and the key ceremony are a pending human decision (plan's "Still needed" table); production UI signing waits on it.
