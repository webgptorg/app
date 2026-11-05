# Deploys and releases

How code reaches staging and production, who approves it, how to roll back, how to rotate each credential and what to do when one leaks (task I-03). Three pipelines, all GitHub Actions workflows in this repo:

| What                        | Workflow                                         | Trigger                                          | Gate                                      |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------ | ----------------------------------------- |
| Dashboard (Worker, SPA, D1) | `deploy-dashboard.yml`, `rollback-dashboard.yml` | push to `main` touching the dashboard¹; dispatch | `staging`, then `production` approval     |
| Relay image                 | `release-relay.yml`                              | push to `main` touching the relay¹; dispatch     | `staging`, then `production` approval     |
| Engine UI bundle (X-03)     | `ui-release.yml`                                 | push of a `ui-v*` tag                            | `release` approval by a second maintainer |

¹ Only while the repository variable `STAGING_DEPLOY_ENABLED` is `true`; until staging exists it is unset, and a push deploys and releases nothing ([staging runbook, Next: CI](../staging-runbook.md#next-ci)). Draft pull requests build nothing.

Every workflow has `permissions: {}` at the top and grants each job only what it uses, pins actions to commit SHAs, caches nothing and passes untrusted values through `env`; zizmor audits them in CI. Pull requests only build: they never get a deploy credential, `id-token: write` or `packages: write`.

## GitHub settings

Environments and environment secrets in a private organization repository need GitHub Team, and required reviewers with "prevent self-review" need Enterprise; the org is on Free, so this waits on the plan's "Still needed" decision. The workflows already name these environments; until they exist with their secrets, no deploy job has a credential, so nothing deploys.

| Environment  | Required reviewers           | Prevent self-review | Deployment refs | Secrets                                                                                    | Variables                                        |
| ------------ | ---------------------------- | ------------------- | --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `staging`    | none (deploys on every push) | —                   | `main`          | `CLOUDFLARE_API_TOKEN` (`ptbk-staging-deploy`)                                             | `CLOUDFLARE_ACCOUNT_ID`, `RELAY_HOSTS`           |
| `production` | the maintainers              | on                  | `main`          | `CLOUDFLARE_API_TOKEN` (`ptbk-production-deploy`)                                          | `CLOUDFLARE_ACCOUNT_ID`, `RELAY_HOSTS`           |
| `release`    | the maintainers              | on                  | tags `ui-v*`    | `UI_STAGING_RELEASE_KEY`, `UI_STAGING_R2_ACCESS_KEY_ID`, `UI_STAGING_R2_SECRET_ACCESS_KEY` | `UI_STAGING_R2_ENDPOINT`, `UI_STAGING_R2_BUCKET` |

- No secret at repository or organization level. `GITHUB_TOKEN` and the OIDC token are per run.
- "Prevent self-review" means the approver is not the person who pushed; with two maintainers, each release needs both.
- `RELAY_HOSTS`: the environment's relay hostnames, space-separated, in rollout order. The relay deploy needs no secret: relays pull, and the jobs move their tags with the run's `GITHUB_TOKEN` (`packages: write`, in the approved job only).
- The R2 token for UI releases has Object Write on the release bucket only.

## Dashboard

On a push to `main` that touches `apps/dashboard`, `packages/protocol`, `packages/ui` or the lockfile:

1. `check`: `bun run check`, including D-01's migration guards (drift, unmarked destructive changes).
2. `staging`: builds with `CLOUDFLARE_ENV=staging`, `wrangler d1 migrations apply DB --env staging --remote`, `wrangler deploy --env staging --strict` (Worker and SPA assets in one upload; `--strict` refuses if someone changed the Worker outside the pipeline), then `scripts/smoke-test.ts`: `/v1/health` answers for `staging`, and `/` is the SPA shell under the exact production CSP.
3. `production`: waits for approval, rebuilds the same commit with `CLOUDFLARE_ENV=production` (the Vite plugin bakes the environment in; wrangler refuses `--env` that does not match the build), applies the migrations, deploys and smoke-tests.

Migrations run before the new Worker and are never undone by a rollback, so every migration works with the Worker that is live: **expand, deploy, contract** ([apps/dashboard/README.md, Migrations](../../apps/dashboard/README.md#migrations)). The pipeline only ever runs `wrangler d1 migrations apply`; nobody runs `drizzle-kit push` or `migrate` against a remote database.

Pull requests build both environments and run `wrangler deploy --dry-run`, with no credential.

### Application secrets

CI never carries them. A maintainer logged in with their own Cloudflare account (`bunx wrangler login`, a super admin with hardware keys) sets them once per environment from `apps/dashboard`, and again when they rotate:

```sh
bunx wrangler secret put RATE_LIMIT_HMAC_KEY --env staging     # base64url, at least 256 bits
```

Production charges, so it needs both Stripe secrets (config refuses `ADAPTERS.billing = "off"` there). Staging runs billing off and needs none (ADR 0017). To switch staging on later, put them first (config accepts them while off and ignores them), then change `ADAPTERS.billing` to `"stripe"` and replace `BILLING_OFF_PLAN` with the commented `BILLING_PLANS` in `wrangler.jsonc`, in one PR, and register the webhook endpoint (`apps/dashboard/README.md`, Environments). No data migration is needed.

```sh
bunx wrangler secret put STRIPE_SECRET_KEY --env production       # rk_live_… (rk_test_… if staging is switched on)
bunx wrangler secret put STRIPE_WEBHOOK_SECRET --env production   # whsec_…
```

### Rolling back the dashboard

1. Find the version: `bunx wrangler versions list --env production` (maintainer login) or the Worker's Deployments tab in Cloudflare. Each deploy carries the message `git <commit>`.
2. Run **Roll back dashboard** (`rollback-dashboard.yml`) from `main` with the environment, the version ID and a reason. It waits for the environment's approval, runs `wrangler rollback`, then the smoke test. The smoke test compares the CSP with the current source, so after a rollback across a CSP change it fails even though the rollback worked; check `/` by hand then.
3. A rollback does not undo migrations. If a migration itself was wrong, fix it forward with a new migration in a PR.

## Relay

`release-relay.yml` on a push to `main` that touches `apps/relay`, `packages/protocol` or the lockfile:

1. `publish` (`packages: write`): builds `apps/relay/Dockerfile` with no cache (Node 24 base pinned by digest, uid 10001), writes an SPDX SBOM with syft, pushes `ghcr.io/webgptorg/relay:git-<commit>` and takes its digest.
2. `sign` (the only job with `id-token: write`): `cosign sign` keylessly through GitHub OIDC, with a Rekor entry and an RFC 3161 timestamp from `timestamp.sigstore.dev`, then verifies exactly as the relays will, and attaches the SBOM and a SLSA v1 provenance as signed attestations.
3. `select`: the digest to roll out, verified again.
4. `staging`, then after approval `production` (`packages: write`): `infra/relay/scripts/rolling-deploy.sh` moves the deploy tag of each relay in `RELAY_HOSTS` in turn and stops at the first failure.

Relays pull their deploys; nothing reaches into a relay to deploy, and there is no deploy key ([decided 2026-10-23](../plan/tasks/I-03-deploy-pipelines.md#decisions)). Each relay follows its own tag, `ghcr.io/webgptorg/relay:deploy-<relay hostname>`. `rolling-deploy.sh` moves the tags one at a time: it points a relay's tag at the digest, waits for that relay's `/healthz` to report it (`ptbk-relay-image`) and to still report it once the relay's deploy window has passed, and only then moves the next tag. If the relay does not take the image, it moves the tag back and stops; the relays after it keep their tags and never pull the image.

What a relay does (`ptbk-relay-deploy.timer`, every minute, runs `ptbk-relay-deploy.service`, root, sandboxed):

1. Reads its tag with the read-only registry token (`/etc/ptbk-relay/credentials/registry-auth` through `LoadCredential`). Nothing to do if it names what runs, or a digest this relay already refused or rolled back from. If the registry, Sigstore's TUF repository or DNS does not answer, the run fails without remembering anything and the next one tries again; only a verdict on the image itself (no or another signature, no timestamp, no build time, too old) is remembered as refused.
2. Verifies the image with cosign: `--certificate-identity https://github.com/webgptorg/app/.github/workflows/release-relay.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-github-workflow-repository webgptorg/app --use-signed-timestamps`, against Sigstore's public-good root through TUF. Exact values from `/etc/ptbk-relay/deploy.env`, never a pattern ([ADR 0014](../adr/0014-cryptography.md)). Anything else is refused before it is pulled.
3. **Downgrade guard:** refuses an image built more than `PTBK_DEPLOY_MAX_DOWNGRADE_DAYS` (30) days before the newest image this relay ever ran (a high-water mark in its state directory that only goes up), or before `PTBK_DEPLOY_MIN_CREATED`, the floor that covers a fresh or rebuilt host. The build time is in the image config, which the signed digest covers; an image without one is refused. Exempt: this relay's previous image (a rollback) and digests listed in `/etc/ptbk-relay/allow-downgrade` (root's, one per line). So moving a tag can only choose a recent signed image, and a chain of small steps cannot walk a relay back either.
4. Pulls it, writes `/var/lib/ptbk-relay-deploy/image.env`, restarts `ptbk-relay.service` (the relay closes its tunnels with `SHUTTING_DOWN`; engines move to a peer relay and come back within 10 s).
5. Waits up to 60 s for the unit to run the new image, `/healthz` to answer on the relay's own hostname with its own certificate, and 90 % of the engines connected before the swap to be back. Otherwise it restores the previous image and remembers the digest as failed.

Tunnel counts stay on the relay: the pipeline sees only which image a relay reports, which is why it waits out the relay's own window instead of reading engine numbers from outside.

### Rolling back a relay

- **Automatic:** a relay that does not come up rolls itself back, and the rollout moves its tag back and stops.
- **To an earlier release, everywhere:** run **Release relay** (`release-relay.yml`) from `main` with `digest: sha256:<…>`. The digest must carry this workflow's signature from `main`; `select` and every relay check it, and it moves the tags as for a release. The previous release always passes the downgrade guard; anything older needs its digest in `allow-downgrade` on each relay first (as an admin). Digests are in each run's summary, on the image's GHCR page, or on a relay: `sudo ptbk-relay-deploy status`.
- **Break glass, one relay at once (admin):** `sudo ptbk-relay-deploy rollback` swaps back to the previous image, which stays on the host, so it needs neither GitHub, GHCR nor Sigstore, and the relay keeps it even though its tag still names the newer image. `sudo ptbk-relay-deploy resume` lets the relay follow its tag again. Use this when the workflow cannot run or is too slow.

A rollback dispatch runs in its own concurrency groups, so it is not queued behind a rollout or replaced by a pending one; it can therefore run while a rollout moves the same tags. In an emergency, cancel the running rollout first, or use break glass.

### What a tag move can and cannot do

`packages: write` is not scoped to an environment: any workflow run that grants it, on any branch, gets a `GITHUB_TOKEN` that can move the `deploy-*` tags, and so can any person with write access to the package. The relays bound what that buys: each one verifies that the image was signed by `release-relay.yml` on `main` and refuses anything built long before the newest image it ever ran. The worst case is therefore a denial of service (tags pointed at images the relays refuse, or at an older recent release), not code we did not sign on `main`, and not an old vulnerable release. Follow-up once the GitHub plan has environment secrets: move the tags with a dedicated, environment-scoped token (a machine account with write access to the relay package only) instead of `GITHUB_TOKEN`, so only an approved environment job can move them.

## UI releases

`ui-release.yml` (X-03) builds, signs and verifies on a `ui-v*` tag; its `publish` job runs in the `release` environment and waits for a second maintainer before it signs with the release key and uploads to the release bucket. Production signing with the human-held release key waits for the key ceremony (plan, "Still needed"). Cutting and verifying a release: [development.md, UI releases](../development.md#ui-releases).

## Rotating credentials

Rotate at least yearly, when someone with access leaves, and at once after a leak (below). Record each rotation (date, who, what) in the ops log.

| Credential                        | Rotate                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ptbk-<env>-deploy` (Cloudflare)  | Create a new token with the scopes in [infra/cloudflare/README.md](../../infra/cloudflare/README.md#api-tokens), check it with `scripts/verify-deploy-token.sh`, put it into the environment's `CLOUDFLARE_API_TOKEN`, run a deploy, then delete the old token in Cloudflare.                                                                                                                                                               |
| GHCR pull token (`registry-auth`) | Never a person's token: a classic `read:packages` token reads every package its owner can, so it belongs to a dedicated machine account whose only access is read on the `relay` package. On each relay: `ssh <admin>@<relay> 'sudo install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/registry-auth' <<< '<account>:<token>'`, then `sudo systemctl start ptbk-relay-deploy.service` and check its journal; then revoke the old token. |
| UI release R2 token               | A new R2 token with Object Write on the release bucket only; update `UI_STAGING_R2_*` in the `release` environment; delete the old token.                                                                                                                                                                                                                                                                                                   |
| `UI_STAGING_RELEASE_KEY`          | `bun run --filter @ptbk/engine-ui release:keygen`, put the public key into `trust-policy.staging.json` in a PR, then the seed into the `release` environment.                                                                                                                                                                                                                                                                               |

## If a credential leaks

First take it out of service, then find out what it was used for, then rotate.

- **`ptbk-<env>-deploy` (Cloudflare).** It can deploy any Worker code to the dashboard and run D1 statements, but not touch DNS or certificates. Delete the token in Cloudflare at once (Manage Account, API Tokens). Check the account's audit log and `wrangler deployments list --env <env>` for deploys that match no run of `deploy-dashboard.yml`; redeploy `main` (dispatch the workflow) or roll back to the last good version. Review D1 for changes made outside the app (`admin_audit_log`, new sessions or passkeys) and treat the accounts involved as compromised. The dashboard holds no engine content, so engine data is not exposed, but treat account data as read.
- **GHCR pull token.** It can read the relay image (commercial code, no secrets in it), and nothing else if it is the machine account's. Revoke it, rotate as above.
- **Write access to the relay package** (a `GITHUB_TOKEN` with `packages: write` during a run, or a person with write access). It can move deploy tags, but only among images `release-relay.yml` signed on `main` and not much older than what runs; a relay refuses anything else. Check each relay's tag and `journalctl -u ptbk-relay-deploy`, and run the workflow with the current release's digest to put the tags back.
- **UI release R2 token.** It can upload to the release bucket; engines install only what verifies (keyless signature, release key, Rekor), so it cannot ship a UI, but it can add junk. Delete it, list the bucket for objects no `ui-release.yml` run uploaded and remove them, rotate.
- **The staging release key.** It signs staging releases only and must never be in a production trust policy. Rotate it as above.
- **A maintainer's GitHub account.** Whoever pushes to `main` gets `release-relay.yml` to sign for them, and the relays would accept that image; `main` has no branch protection yet, so the `production` approval by another maintainer is the gate. Remove the account from the organization, review recent pushes to `main` and the runs they started, and roll back anything that did not come from a reviewed PR.
- **An OIDC token or `GITHUB_TOKEN`.** Both expire with the run (at most a few hours) and are scoped to it; check the run's logs, the packages it pushed and the tags it moved.

Whatever leaked, note it in the ops log and in the incident record, with the rotation.
