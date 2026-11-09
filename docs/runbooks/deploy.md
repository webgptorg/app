# Deploys and releases

How code reaches staging and production, who approves it, how to roll back, how to rotate each credential and what to do when one leaks (task I-03). Three pipelines. GitHub Actions builds and signs for all three, keylessly; whatever needs a deploy secret, a maintainer runs from their own machine ([GitHub settings](#github-settings)):

| What                        | In CI                                                                                     | Deployed by                                                                                                                  | Gate                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Dashboard (Worker, SPA, D1) | `deploy-dashboard.yml` builds and dry-runs pull requests                                  | a maintainer, from `main` ([below](#dashboard)); `deploy-dashboard.yml`, `rollback-dashboard.yml` with `DASHBOARD_CI_DEPLOY` | only maintainers hold the deploy token                    |
| Relay image                 | `release-relay.yml` builds and signs on a push to `main` touching the relay¹, or dispatch | `release-relay.yml`: staging on every run, production on a dispatch with `production`                                        | the relays' signature check; the dispatch, for production |
| Engine UI bundle (X-03)     | `ui-release.yml` builds and signs on a `ui-v*` tag push                                   | a maintainer, from the run's artifacts ([below](#ui-releases)); the `publish` job with `UI_CI_PUBLISH`                       | only maintainers hold the release key and the R2 token    |

¹ Only while the repository variable `STAGING_DEPLOY_ENABLED` is `true`; until staging exists it is unset, and a push deploys and releases nothing ([staging runbook, Next: CI](../staging-runbook.md#next-ci)). Draft pull requests build nothing.

Every workflow has `permissions: {}` at the top and grants each job only what it uses, pins actions to commit SHAs, caches nothing and passes untrusted values through `env`; zizmor audits them in CI. Pull requests only build: they never get a deploy credential, `id-token: write` or `packages: write`.

## GitHub settings

The organization stays on GitHub Free (decided 2026-11-09). Free has no environments, environment secrets, required reviewers or deployment branch rules in a private repository, so **no deploy secret is in GitHub at all**, not even at repository level. CI uses only the run's `GITHUB_TOKEN` and OIDC token: it builds, signs keylessly and moves the relays' deploy tags. The Cloudflare deploy token, the UI release key and the R2 token stay in the maintainers' password manager, and the steps that need them run from a maintainer's machine. Repository variables (Settings, Secrets and variables, Actions, **Variables**, or `gh variable set <name> --body <value>`), none of them secret:

| Variable                 | Value                                                           | What it switches                                                                                                                         |
| ------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `STAGING_DEPLOY_ENABLED` | `true` once staging exists                                      | A push to `main` releases the relay to staging (and deploys the dashboard, if `DASHBOARD_CI_DEPLOY` is set); unset, only a dispatch does |
| `STAGING_RELAY_HOSTS`    | `relay-fsn.ptbk.link`                                           | The staging relays, space-separated, in rollout order                                                                                    |
| `PRODUCTION_RELAY_HOSTS` | the production relays, e.g. `relay-1.<domain> relay-2.<domain>` | The same for production, rolled out only by a dispatch with `production`                                                                 |
| `DASHBOARD_CI_DEPLOY`    | unset (paid plan only)                                          | `deploy-dashboard.yml` and `rollback-dashboard.yml` deploy with the environments' token                                                  |
| `UI_CI_PUBLISH`          | unset (paid plan only)                                          | `ui-release.yml`'s `publish` job signs with the release key and uploads, from the `release` environment                                  |

**The trade-off.** Nothing in GitHub makes a second maintainer approve a production relay rollout: anyone with write access who dispatches **Release relay** from `main` with `production` rolls it out, and the dispatch is the approval. What a rollout can install is unchanged: each relay accepts only an image `release-relay.yml` signed on `main` (exact identity, issuer, Rekor entry and timestamp) and refuses one much older than what it runs, so a careless or stolen dispatch can at worst roll out what is on `main`. The dashboard and UI releases keep their human gate, because their credentials never leave the maintainers' machines.

**With a paid plan later**, nothing needs rewriting: the dashboard and UI workflows still name their environments. Create the environments below, then set `DASHBOARD_CI_DEPLOY` and `UI_CI_PUBLISH` to `true`, and give the relay's `production` job `environment: production` back for its approval. Environments and environment secrets in a private organization repository need GitHub Team; required reviewers with "prevent self-review" need Enterprise.

| Environment  | Required reviewers           | Prevent self-review | Deployment refs | Secrets                                                                                    | Variables                                        |
| ------------ | ---------------------------- | ------------------- | --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `staging`    | none (deploys on every push) | —                   | `main`          | `CLOUDFLARE_API_TOKEN` (`ptbk-staging-deploy`)                                             | `CLOUDFLARE_ACCOUNT_ID`                          |
| `production` | the maintainers              | on                  | `main`          | `CLOUDFLARE_API_TOKEN` (`ptbk-production-deploy`)                                          | `CLOUDFLARE_ACCOUNT_ID`                          |
| `release`    | the maintainers              | on                  | tags `ui-v*`    | `UI_STAGING_RELEASE_KEY`, `UI_STAGING_R2_ACCESS_KEY_ID`, `UI_STAGING_R2_SECRET_ACCESS_KEY` | `UI_STAGING_R2_ENDPOINT`, `UI_STAGING_R2_BUCKET` |

- "Prevent self-review" means the approver is not the person who pushed; with two maintainers, each release needs both.
- The relay deploy needs no secret in either case: relays pull, and the jobs move their tags with the run's `GITHUB_TOKEN` (`packages: write`).
- The R2 token for UI releases has Object Write on the release bucket only.

## Dashboard

**By hand, until `DASHBOARD_CI_DEPLOY`.** A maintainer deploys from a clean, up-to-date `main`, with the deploy token from the password manager: the same steps as the workflow's staging job ([staging runbook, step 8](../staging-runbook.md#8-dashboard) did the first one). Production is the same with `CLOUDFLARE_ENV=production`, `--env production`, its own token and its origin.

```sh
cd apps/dashboard
bun run db:check   # the migration guards: drift, unmarked destructive changes
bun run generate && CLOUDFLARE_ENV=staging bun run build
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN  # ptbk-staging-deploy
export CLOUDFLARE_ACCOUNT_ID=42b20127fa7293cb5160f22ed42ef43b
bunx wrangler d1 migrations apply DB --env staging --remote
bunx wrangler deploy --env staging --strict --message "git $(git rev-parse HEAD)"
unset CLOUDFLARE_API_TOKEN
node scripts/smoke-test.ts --origin https://app.ptbk.io --environment staging
```

`deploy-dashboard.yml`, once `DASHBOARD_CI_DEPLOY` is `true` (paid plan), on a push to `main` that touches `apps/dashboard`, `packages/protocol`, `packages/ui` or the lockfile:

1. `check`: `bun run check`, including D-01's migration guards (drift, unmarked destructive changes).
2. `staging`: builds with `CLOUDFLARE_ENV=staging`, `wrangler d1 migrations apply DB --env staging --remote`, `wrangler deploy --env staging --strict` (Worker and SPA assets in one upload; `--strict` refuses if someone changed the Worker outside the pipeline), then `scripts/smoke-test.ts`: `/v1/health` answers for `staging`, and `/` is the SPA shell under the exact production CSP.
3. `production`: waits for approval, rebuilds the same commit with `CLOUDFLARE_ENV=production` (the Vite plugin bakes the environment in; wrangler refuses `--env` that does not match the build), applies the migrations, deploys and smoke-tests.

Migrations run before the new Worker and are never undone by a rollback, so every migration works with the Worker that is live: **expand, deploy, contract** ([apps/dashboard/README.md, Migrations](../../apps/dashboard/README.md#migrations)). Deploys only ever run `wrangler d1 migrations apply`; nobody runs `drizzle-kit push` or `migrate` against a remote database.

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
2. From `apps/dashboard`, with the deploy token exported as above: `bunx wrangler rollback <version> --env production --message "<reason>"`, then the smoke test. Once `DASHBOARD_CI_DEPLOY` is set, **Roll back dashboard** (`rollback-dashboard.yml`) from `main` does the same behind the environment's approval. The smoke test compares the CSP with the current source, so after a rollback across a CSP change it fails even though the rollback worked; check `/` by hand then.
3. A rollback does not undo migrations. If a migration itself was wrong, fix it forward with a new migration in a PR.

## Relay

`release-relay.yml` on a push to `main` that touches `apps/relay`, `packages/protocol` or the lockfile:

1. `publish` (`packages: write`): builds `apps/relay/Dockerfile` with no cache (Node 24 base pinned by digest, uid 10001), writes an SPDX SBOM with syft, pushes `ghcr.io/webgptorg/relay:git-<commit>` and takes its digest.
2. `sign` (the only job with `id-token: write`): `cosign sign` keylessly through GitHub OIDC, with a Rekor entry and an RFC 3161 timestamp from `timestamp.sigstore.dev`, then verifies exactly as the relays will, and attaches the SBOM and a SLSA v1 provenance as signed attestations.
3. `select`: the digest to roll out, verified again.
4. `staging` (`packages: write`): `infra/relay/scripts/rolling-deploy.sh` moves the deploy tag of each relay in `STAGING_RELAY_HOSTS` in turn and stops at the first failure.
5. `production`, only on a dispatch from `main` with `production` checked, after staging succeeded: the same for `PRODUCTION_RELAY_HOSTS`. A push never reaches production.

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
- **To an earlier release, everywhere:** run **Release relay** (`release-relay.yml`) from `main` with `digest: sha256:<…>`, and `production` checked to include production. The digest must carry this workflow's signature from `main`; `select` and every relay check it, and it moves the tags as for a release. The previous release always passes the downgrade guard; anything older needs its digest in `allow-downgrade` on each relay first (as an admin). Digests are in each run's summary, on the image's GHCR page, or on a relay: `sudo ptbk-relay-deploy status`.
- **Break glass, one relay at once (admin):** `sudo ptbk-relay-deploy rollback` swaps back to the previous image, which stays on the host, so it needs neither GitHub, GHCR nor Sigstore, and the relay keeps it even though its tag still names the newer image. `sudo ptbk-relay-deploy resume` lets the relay follow its tag again. Use this when the workflow cannot run or is too slow.

A rollback dispatch runs in its own concurrency groups, so it is not queued behind a rollout or replaced by a pending one; it can therefore run while a rollout moves the same tags. In an emergency, cancel the running rollout first, or use break glass.

### What a tag move can and cannot do

`packages: write` is not scoped to an environment: any workflow run that grants it, on any branch, gets a `GITHUB_TOKEN` that can move the `deploy-*` tags, and so can any person with write access to the package. The relays bound what that buys: each one verifies that the image was signed by `release-relay.yml` on `main` and refuses anything built long before the newest image it ever ran. The worst case is therefore a denial of service (tags pointed at images the relays refuse, or at an older recent release), not code we did not sign on `main`, and not an old vulnerable release. Follow-up once the GitHub plan has environment secrets: move the tags with a dedicated, environment-scoped token (a machine account with write access to the relay package only) instead of `GITHUB_TOKEN`, so only an approved environment job can move them.

## UI releases

`ui-release.yml` (X-03) builds and signs keylessly on a `ui-v*` tag; that keyless provenance is what `release:verify` and every engine require, and only the tag's run can make it. Its `publish` job, which adds the release-key signature and uploads, runs only once `UI_CI_PUBLISH` is `true` (paid plan, `release` environment). Until then a maintainer publishes from a clean, up-to-date `main`, within 7 days of the run (the artifacts' retention), with the release key and the R2 token from the password manager. Production signing with the human-held release key waits for the key ceremony (plan, "Still needed"). Cutting a release: [development.md, UI releases](../development.md#ui-releases).

```sh
run=<run ID>                                         # gh run list --workflow ui-release.yml
git clean -fdX apps/engine-ui/release                # release:sign never overwrites a release.json
gh run download "$run" -n ui-bundle -D apps/engine-ui/release
gh run download "$run" -n ui-signatures -D apps/engine-ui/release
read -rs UI_RELEASE_KEY && export UI_RELEASE_KEY     # the UI_STAGING_RELEASE_KEY seed
bun run --filter @ptbk/engine-ui release:sign
unset UI_RELEASE_KEY
bun run --filter @ptbk/engine-ui release:verify release
export R2_ENDPOINT=https://42b20127fa7293cb5160f22ed42ef43b.r2.cloudflarestorage.com R2_BUCKET=ptbk-ui-releases-staging
read -rs R2_ACCESS_KEY_ID && export R2_ACCESS_KEY_ID
read -rs R2_SECRET_ACCESS_KEY && export R2_SECRET_ACCESS_KEY
bun run --filter @ptbk/engine-ui release:publish --version <version>
unset R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
```

Download each artifact on its own: `gh run download` with several `-n` puts each into a subdirectory, where the scripts do not look. `release:verify` checks everything an engine checks, against the staging trust policy, and prints the tag and `<version>`. A dry-run tag (`ui-v0.0.0-dryrun.<n>`) stops there: it is never published. `release:publish` refuses a version that already exists.

## Rotating credentials

Rotate at least yearly, when someone with access leaves, and at once after a leak (below). Record each rotation (date, who, what) in the ops log.

| Credential                        | Rotate                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ptbk-<env>-deploy` (Cloudflare)  | Create a new token with the scopes in [infra/cloudflare/README.md](../../infra/cloudflare/README.md#api-tokens), check it with `scripts/verify-deploy-token.sh`, store it in the password manager (and the environment's `CLOUDFLARE_API_TOKEN`, once there is one), run a deploy, then delete the old token in Cloudflare.                                                                                                                 |
| GHCR pull token (`registry-auth`) | Never a person's token: a classic `read:packages` token reads every package its owner can, so it belongs to a dedicated machine account whose only access is read on the `relay` package. On each relay: `ssh <admin>@<relay> 'sudo install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/registry-auth' <<< '<account>:<token>'`, then `sudo systemctl start ptbk-relay-deploy.service` and check its journal; then revoke the old token. |
| UI release R2 token               | A new R2 token with Object Write on the release bucket only; store it in the password manager (and the `release` environment, once there is one); delete the old token.                                                                                                                                                                                                                                                                     |
| `UI_STAGING_RELEASE_KEY`          | `bun run --filter @ptbk/engine-ui release:keygen`, put the public key into `trust-policy.staging.json` in a PR, then the seed into the password manager (and the `release` environment, once there is one).                                                                                                                                                                                                                                 |

## If a credential leaks

First take it out of service, then find out what it was used for, then rotate.

- **`ptbk-<env>-deploy` (Cloudflare).** It can deploy any Worker code to the dashboard and run D1 statements, but not touch DNS or certificates. Delete the token in Cloudflare at once (Manage Account, API Tokens). Check the account's audit log and `wrangler deployments list --env <env>` for deploys that match no deploy a maintainer made (each carries `git <commit>`); redeploy `main` ([Dashboard](#dashboard)) or roll back to the last good version. Review D1 for changes made outside the app (`admin_audit_log`, new sessions or passkeys) and treat the accounts involved as compromised. The dashboard holds no engine content, so engine data is not exposed, but treat account data as read.
- **GHCR pull token.** It can read the relay image (commercial code, no secrets in it), and nothing else if it is the machine account's. Revoke it, rotate as above.
- **Write access to the relay package** (a `GITHUB_TOKEN` with `packages: write` during a run, or a person with write access). It can move deploy tags, but only among images `release-relay.yml` signed on `main` and not much older than what runs; a relay refuses anything else. Check each relay's tag and `journalctl -u ptbk-relay-deploy`, and run the workflow with the current release's digest to put the tags back.
- **UI release R2 token.** It can upload to the release bucket; engines install only what verifies (keyless signature, release key, Rekor), so it cannot ship a UI, but it can add junk. Delete it, list the bucket for objects that match no release a maintainer published and remove them, rotate.
- **The staging release key.** It signs staging releases only and must never be in a production trust policy. Rotate it as above.
- **A maintainer's GitHub account.** Whoever pushes to `main` gets `release-relay.yml` to sign for them, and the relays would accept that image; `main` has no branch protection and production relay rollouts no approval ([the trade-off](#github-settings)), so the account can put its own code on every relay. It cannot deploy the dashboard or publish a UI: those credentials are not in GitHub. Remove the account from the organization, review recent pushes to `main` and the runs they started, and roll back anything that did not come from a reviewed PR.
- **An OIDC token or `GITHUB_TOKEN`.** Both expire with the run (at most a few hours) and are scoped to it; check the run's logs, the packages it pushed and the tags it moved.

Whatever leaked, note it in the ops log and in the incident record, with the rotation.
