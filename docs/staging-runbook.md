# Staging runbook

Bringing staging up by hand from a laptop, once, without CI: accounts, tokens, secrets, DNS, the dashboard, email, the relay host and a linked engine. Everything is here in order, so you need no task brief. It collects the Apply steps of I-01, I-02, I-04 and X-03 ([apply.md](plan/apply.md)) for staging, and links the module docs for detail.

Decided on 2026-11-04 and changed on 2026-11-06: this is the one environment, and it gradually becomes production. It runs in an existing Cloudflare account that it shares with other projects (Pavol's), on one domain that account holds, `ptbk.link`, with subdomains. The dashboard is on `app.ptbk.io`, the URL engines have built in: `ptbk.io` is a zone in the engine team's Cloudflare account, which we hold no token for, so `app.ptbk.io` is a Cloudflare for SaaS custom hostname of `ptbk.link` and its owner adds a few DNS records for us ([DNS records for the ptbk.io owner](#dns-records-for-the-ptbkio-owner)) ([Staging relaxations](#staging-relaxations-not-for-production) lists what that gives up), one relay on Hetzner with `relay_dns_mode = "records"` and no load balancer, and billing off (`ADAPTERS.billing = "off"`), so no Stripe. GitHub Actions does not run (billing), so every step here runs from your machine. The CI pipelines (I-03) come later.

**What you have at the end:** the dashboard on `https://app.ptbk.io/` with passkey sign-up, D1 and migrations; email that passes SPF, DKIM and DMARC; engines under `engines.ptbk.link` with a DNS-only wildcard and CAA; a hardened relay host with its own certificate, registered with the dashboard; and an engine linked to the dashboard and sending heartbeats.

**What waits for GitHub Actions:** the relay itself (hosts run only images signed by `release-relay.yml`, [step 10](#10-relay-secrets-certificate-registration)), and with it browser traffic to engines; the engine UI release ([step 11](#11-ui-release-prepare-now-publish-with-ci)). The e2e suite cannot target staging yet ([step 13](#13-e2e-against-staging)).

| Step                                                                                        | Time                         | Needs                      |
| ------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------- |
| [0. Before you start](#0-before-you-start)                                                  | 5 min                        | —                          |
| [1. Account and domain](#1-account-and-domain)                                              | 15 min                       | the shared account, a card |
| [2. API tokens](#2-api-tokens)                                                              | 10 min                       | 1                          |
| [3. R2 buckets](#3-r2-buckets)                                                              | 3 min                        | 1                          |
| [4. Secrets](#4-secrets)                                                                    | 5 min                        | —                          |
| [5. Placeholders](#5-placeholders)                                                          | 5 min, then 1 min twice more | 1                          |
| [6. Relay host: create](#6-relay-host-create)                                               | 10 min (boot included)       | 2 to 5                     |
| [7. Cloudflare stack](#7-cloudflare-stack)                                                  | 10 min, plus DNS propagation | 6                          |
| [8. Dashboard](#8-dashboard)                                                                | 15 min                       | 7                          |
| [9. Test email](#9-test-email)                                                              | 10 min                       | 8                          |
| [10. Relay: secrets, certificate, registration](#10-relay-secrets-certificate-registration) | 15 min                       | 8; the image waits for CI  |
| [11. UI release](#11-ui-release-prepare-now-publish-with-ci)                                | 5 min now                    | publishing waits for CI    |
| [12. Link an engine](#12-link-an-engine)                                                    | 10 min                       | 8                          |
| [13. e2e against staging](#13-e2e-against-staging)                                          | —                            | not supported yet          |
| [14. Teardown and reset](#14-teardown-and-reset)                                            | as needed                    | —                          |
| [DNS records for the ptbk.io owner](#dns-records-for-the-ptbkio-owner)                      | his time, twice              | 7, then 8                  |

About 1.5 hours of hands-on time. Each step ends with **You should see** (the check) and **If it fails** (the most likely cause).

## Staging relaxations (not for production)

Staging runs on one domain, `ptbk.link`, in a shared account (decided by Seb on 2026-11-06; [ADR 0011](adr/0011-infrastructure-as-code.md), [infra/cloudflare README, Staging: one domain](../infra/cloudflare/README.md#staging-one-domain)). It is the one environment and gradually becomes production; the production design keeps its own account, its own engine domain zone, a separate ACME challenge zone, DNSSEC, CAA and the PSL entry, and the production root in `infra/cloudflare` stays as that design. Until this environment meets it:

- **Engines share the registrable domain `ptbk.link`** with the relay, the UI releases, the sending domain and the dashboard's fallback origin. The dashboard itself is on `app.ptbk.io`, another site. Engines' sibling hosts are contained as in production: the engine gateway uses host-only `__Host-` session cookies, which a sibling host can neither set nor shadow ([gateway.md](engine-integration/gateway.md)).
- **The dashboard's hostname is in a zone we do not control.** The engine team's account can repoint `app.ptbk.io` or have a certificate issued for it (`ptbk.io` has no CAA), and Cloudflare for SaaS serves it from `ptbk.link`; we hold no token for `ptbk.io` and never need one. The dashboard is same-site with every other `ptbk.io` host (the website, the `*.ptbk.io` wildcard), which its host-only `__Host-` session cookies and its refusal of state changes that are not `Sec-Fetch-Site: same-origin` contain.
- **The relay's DNS token can edit the whole staging zone** (`ptbk.link`), so a compromised relay host could change any staging DNS record and obtain certificates for staging engine hostnames, which production's separate challenge zone prevents.
- **No DNSSEC, PSL entry or engine-zone CAA hardening**: Universal SSL stays on in the shared zone (Cloudflare may add CAA records for its own CAs), and the engines' DMARC record does not cover engine hostnames, whose organizational domain is the staging zone.
- **The shared account means Workers and D1 tokens**, which Cloudflare cannot scope to one script or database, **reach every Worker and D1 database in that account** (and the analytics token all of its analytics, the IaC token's Workers R2 Storage Edit every bucket): keep the staging deploy token only on Seb's machine and later in the `staging` GitHub environment; production gets its own account.
- **SSH to the relay is reachable from every address**, keys only (no root, passwords or forwarding), because admins work from changing networks (decided 2026-11-06); production allowlists it.
- **The tokens are user-owned** (Seb's, step 2), not account-owned: they can do at most what his role can, and stop when he loses access to the account.

Staging links only mock engines and throwaway `ptbk` projects that hold test data only: never a real project, real content or real credentials. Anything that would put real engine content on staging needs these revisited first.

## 0. Before you start

- An up-to-date checkout of `main` with `bun install` done; Node 24 (`nvm use`), [OpenTofu](https://opentofu.org/docs/intro/install/) 1.10 or later, `dig` (BIND tools), `jq`, `ssh`, and `nmap` for one check.
- Two hardware security keys, and a password manager vault for staging (one entry per secret below).
- `ADAPTERS.billing` is `"off"` in `env.staging` of [apps/dashboard/wrangler.jsonc](../apps/dashboard/wrangler.jsonc). Every organization then holds `BILLING_OFF_PLAN` (engines, up to 10 per organization; a plain `wrangler.jsonc` value, so changing it needs no code) with no Stripe secrets or IDs; the Stripe catalogue stays commented out next to it. Stripe is needed only when billing is switched on ([apply.md](plan/apply.md) step 2).
- Secrets never go into the repo, a PR, a chat, a log or this page. Values in `staging.env` are not secrets (IDs, domains, addresses) and end up committed.

## 1. Account and domain

### 1.1 Cloudflare account

Staging uses an existing Cloudflare account that it shares with other projects, so there is nothing to create, only to check. Production gets an account of its own later ([infra/cloudflare README, Bootstrap](../infra/cloudflare/README.md#bootstrap-once-per-environment)).

1. Your login reaches the account with a role that covers every permission in [step 2](#2-api-tokens) (D1, Workers, R2, Email Service, analytics, and DNS, SSL and Workers routes on `ptbk.link`), and it has two-factor authentication on (hardware security keys if you can). It need not be Administrator: the tokens are your own (step 2).
2. Workers & Pages, Plans: **Workers Paid**. The dashboard Worker uses Durable Objects, seven rate-limit bindings, two cron triggers, Analytics Engine and Email Service. If the account is on the free plan, ask its owner before upgrading: they pay for it.
3. R2 Object Storage has been opened once and its plan accepted (the free tier is enough).
4. **Email Service** (Cloudflare's sending service) is enabled for the account. Step 7 creates the sending domain and fails without it.
5. **Cloudflare for SaaS** is enabled on `ptbk.link` (the zone's SSL/TLS, Custom Hostnames, Enable). Every plan includes 100 custom hostnames, then $0.10 each; we use one. Cloudflare may ask for a payment method first. Step 7 creates `app.ptbk.io` and fails without it.
6. Nothing in the account uses our names yet: Worker `ptbk-dashboard-staging`, D1 database `ptbk-dashboard-staging`, R2 buckets `ptbk-tofu-state-staging` and `ptbk-ui-releases-staging`.
7. The account ID (Account Home, the account's menu, Copy account ID) is `42b20127fa7293cb5160f22ed42ef43b`, committed in the staging configs (not secret).

**You should see:** your role on the Members page, Workers Paid on the plan page, Email Service enabled, and Custom Hostnames available on `ptbk.link`.
**If it fails:** if a permission in step 2 is not offered when you create a token, your role is too narrow: ask the account owner. Email Service may be in beta or need a request for the account. Ask for it now: it is the only thing that takes longer than this hour.

### 1.2 Domain: ptbk.link

`ptbk.link` holds all of staging but the dashboard's own hostname, and is already a zone in the shared account. Its names are committed in the staging configs, not placeholders:

| Name                                  | What                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `app.ptbk.io`                         | The dashboard: a custom hostname of `ptbk.link`; its DNS is the `ptbk.io` owner's                    |
| `app-origin.ptbk.link`                | The custom hostname's fallback origin (`AAAA 100::`, proxied), which `app.ptbk.io` points at         |
| `relay-fsn.ptbk.link`                 | The relay's hostname                                                                                 |
| `mail.ptbk.link`                      | The email sending subdomain                                                                          |
| `*.engines.ptbk.link`                 | Engine hostnames: the DNS-only wildcard to the relay; CAA and no-mail records on `engines.ptbk.link` |
| `_acme-challenge.relay-fsn.ptbk.link` | The TXT records lego writes for the relay's certificate, directly in `ptbk.link`                     |

Check that the zone is **Active** in the shared account, that it has auto-renew and the transfer lock on (Domain Registration, if it is registered at Cloudflare), and that it has no records under these names yet. Add no records by hand; the stack adds its records and leaves the zone's others alone. Its zone ID, `c203cd9d66f14a374dbdd2df74f6380a` (the zone's Overview, API section), is committed here for steps 7 and 8.

**You should see:** `ptbk.link` **Active** in the shared account, with none of the names above taken.
**If it fails:** if `ptbk.link` is in another account, the stack cannot find it (step 7): move the zone into the shared account, or ask Seb which account to use.

### 1.3 Hetzner

1. In the [Hetzner Console](https://console.hetzner.com), turn on two-factor authentication for your login, then create a project `ptbk-staging`.
2. In the project, Security, API tokens: generate a **Read & Write** token named `ptbk-staging-tofu`. Store it as `HCLOUD_TOKEN`.
3. Check the admin SSH public key committed in `infra/relay/environments/staging/terraform.tfvars` (`admins`; ideally `sk-ssh-ed25519` on a hardware key; the relay also accepts `ssh-ed25519` and ECDSA P-256, never RSA). Another admin adds theirs there in a PR. Staging sets `ssh_from_anywhere = true`, so there is no network allowlist to note.

**You should see:** an empty project with one API token.
**If it fails:** a new Hetzner account may be asked to verify its identity before it can create a server. Do this first so that step 6 is not stuck on it. Note that the admin keys and SSH access reach the host only at first boot: changing them later means a host rebuild ([infra/relay README, Rotate secrets](../infra/relay/README.md#rotate-secrets)).

## 2. API tokens

Create the Cloudflare tokens as **user-owned tokens** under My Profile, **API Tokens**, Create Token, Custom token, with the account resource set to the shared account only. That is the expected path here: account-owned tokens (Manage Account, Account API Tokens) need Super Administrator or Administrator, which Seb does not have in this account. A user-owned token can do at most what its user can and stops working when that user loses access, so whoever leaves the account first rotates these ([deploy runbook, If a credential leaks](runbooks/deploy.md#if-a-credential-leaks)); production uses account-owned tokens in its own account. Scope every zone permission to **`ptbk.link` only**: the account holds other projects' zones. Cloudflare cannot scope Workers, D1 or analytics permissions below the account, so those reach the whole shared account ([Staging relaxations](#staging-relaxations-not-for-production)). The scopes are copied from [infra/cloudflare/README.md](../infra/cloudflare/README.md#api-tokens) and [docs/runbooks/observability.md](runbooks/observability.md#credentials). Store every token in the password manager, nowhere else.

| Token                                  | Permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Never                                                               | Used in             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------- |
| `ptbk-staging-iac`                     | Account: D1 Edit, the Email Service sending permission (record its exact name in infra/cloudflare/README.md), Load Balancing: Monitors and Pools Edit, Notifications Edit, Workers R2 Storage Edit (the `ui.ptbk.link` custom domain; reaches every bucket in the shared account). Zone, **`ptbk.link` only**: Zone Read, DNS Edit, Load Balancers Edit, SSL and Certificates Edit (the custom hostname `app.ptbk.io`, its fallback origin and DCV delegation; confirm at step 7 that it covers them and record the result in infra/cloudflare/README.md) | Workers, API tokens, members, billing; any other zone; CI; any host | Steps 7, 9          |
| `ptbk-staging-deploy`                  | Account: Workers Scripts Edit (includes Durable Objects), D1 Edit, Account Settings Read. Zone, **`ptbk.link` only**: Workers Routes Edit (the `app.ptbk.io/*` route). Reaches every Worker and D1 database in the shared account, so it lives only on Seb's machine, and later in the `staging` GitHub environment                                                                                                                                                                                                                                       | Any DNS or SSL permission; any other zone; anything on `ptbk.io`    | Steps 8, 10, 12     |
| R2 token for `ptbk-tofu-state-staging` | Created in step 3: R2, Manage API tokens, Create User API token, **Object Read & Write**, specific bucket `ptbk-tofu-state-staging`. Gives an Access Key ID and a Secret Access Key                                                                                                                                                                                                                                                                                                                                                                       | Any other bucket                                                    | Steps 6, 7          |
| `ptbk-staging-acme-dns`                | Zone: Zone Read, DNS Edit, on **`ptbk.link` only** (there is no challenge zone on staging). After step 6, add the relay's IPv4 and IPv6 addresses to the token's client IP filter                                                                                                                                                                                                                                                                                                                                                                         | Any other zone                                                      | Step 10 (the relay) |
| `ptbk-staging-analytics`               | Account: Account Analytics Read, nothing else. Required: staging sets `MONITORING`, and the Worker refuses to start without `ANALYTICS_API_TOKEN` there                                                                                                                                                                                                                                                                                                                                                                                                   | Everything else                                                     | Step 8              |
| UI release R2 token                    | Only with CI (step 11): Object Read & Write on the release bucket only (R2 offers no write-only object permission)                                                                                                                                                                                                                                                                                                                                                                                                                                        | Any other bucket                                                    | Later               |

No token reaches `ptbk.io`: its owner adds our records by hand. The IaC token's load-balancing permissions are unused while staging is on `"records"`; they are kept so that staging matches production's token. Plus `HCLOUD_TOKEN` from 1.3.

**You should see:** four tokens under My Profile, API Tokens and one under R2's API tokens (after step 3); each one's summary shows exactly the permissions above, on the shared account and `ptbk.link` only.
**If it fails:** a permission that the form does not offer means your role in the account lacks it: ask the account owner to widen your role, not for an Administrator token.

## 3. R2 buckets

R2, Create bucket:

In the shared account:

1. `ptbk-tofu-state-staging`, location **Automatic** (or a location hint), **no jurisdiction**. The backend's endpoint is `https://<account id>.r2.cloudflarestorage.com`, and an EU-jurisdiction bucket lives at another endpoint. OpenTofu state for both stacks lives here, under `cloudflare/terraform.tfstate` and `relay/terraform.tfstate`. Then create its R2 token (step 2).
2. `ptbk-ui-releases-staging`, the UI release bucket (`UI_STAGING_R2_BUCKET`), location **Automatic**, no jurisdiction. The stack serves it as `ui.ptbk.link` (step 7), so it must exist before the first apply. Leave its public r2.dev access off.

**You should see:** two empty buckets.
**If it fails:** `tofu init` later answers 403. The R2 token is scoped to another bucket, or the account ID in the backend endpoint is wrong.

## 4. Secrets

Generate every self-generated secret in one go, in a terminal nobody can see. It prints them and writes nothing:

```sh
node scripts/staging/generate-secrets.ts --relay relay-fsn.ptbk.link
```

| Secret                    | Format (what parses it)                                                  | Goes to                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TF_VAR_state_passphrase` | 43 base64url characters (at least 32 random characters)                  | Password manager; `export TF_VAR_state_passphrase=…` for both stacks. Losing it means rebuilding state by import                                                                                                                                          |
| `RATE_LIMIT_HMAC_KEY`     | 32 bytes, base64url without padding (`apps/dashboard/src/app/config.ts`) | Password manager; `bunx wrangler secret put RATE_LIMIT_HMAC_KEY --env staging` (step 8)                                                                                                                                                                   |
| `MEMBER_KEY`              | 32-byte Ed25519 seed, base64url without padding                          | Password manager; `bunx wrangler secret put MEMBER_KEY --env staging`                                                                                                                                                                                     |
| Metrics token             | `ptbk_mt_` and 43 base64url characters, one per relay                    | Password manager; the relay's `/etc/ptbk-relay/credentials/metrics-token` (step 10)                                                                                                                                                                       |
| `RELAY_METRICS_TOKENS`    | `{"relay-fsn.ptbk.link":"ptbk_mt_…"}`, the same token                    | `bunx wrangler secret put RELAY_METRICS_TOKENS --env staging`                                                                                                                                                                                             |
| `UI_STAGING_RELEASE_KEY`  | 32-byte Ed25519 seed, base64url (X-03's `release:keygen` format)         | Password manager; later the `release` GitHub environment. Its printed **public** key is `releaseKeys[0].publicKey` in [trust-policy.staging.json](../apps/engine-ui/release/trust-policy.staging.json) (committed; a new key needs a PR that replaces it) |

Not generated by the script: the API tokens (step 2), the relay registry token (minted against D1 in step 10), and your SSH key (`ssh-keygen -t ed25519-sk` on a hardware key). The staging trust policy's three `maintainerKeys` matter only for `security` releases and stay as they are.

**You should see:** six values and one public key. Clear the terminal (Cmd+K) once they are stored.
**If it fails:** `usage:` means the relay hostname is missing or not lower case.

## 5. Placeholders

Every staging value lives in one local, git-ignored file, `staging.env` at the repo root, and one script writes them into the configs. Do it on a branch of its own, and commit the result as a normal PR (`chore(infra): fill in the staging values`):

```sh
git fetch origin && git switch -c chore/staging-values origin/main
cat > staging.env <<'EOF'
# After step 6
RELAY_IPV4=
RELAY_IPV6=
# After step 7
D1_DATABASE_ID=
EOF
node scripts/staging/fill-placeholders.ts           # fills what is known, lists what is left and why
node scripts/staging/fill-placeholders.ts --check   # exit 0 once nothing staging.env can fill is left
```

Run it again after steps 6 and 7. It only replaces what is still a placeholder, never touches production, and refuses malformed values and anything that would break out of a string. The contacts and the install guide are committed: `security@`, `ops@` and `abuse@ptbk.link` are stand-ins that receive no mail (`ptbk.link` has no MX), and the guide is the engine's App connection spec. Replace the three addresses with read mailboxes before real users arrive: until then alerts and abuse reports bounce.

Strictly, plan and apply run from an up-to-date `main` ([infra/cloudflare README, Running](../infra/cloudflare/README.md#running)). For this bootstrap, the values arrive one round at a time, so apply from this branch rebased on `origin/main`, then merge its PR in the same session, with the DNS checks, the email headers and the token check (steps 7 to 9) in its body.

The domains (`ptbk.link` and the names under it), the account ID, the admin SSH key, the contacts, the install guide and the UI release key are committed values, not placeholders. Every staging placeholder:

| Placeholder                                                    | File                                              | `staging.env`              | Comes from                                |
| -------------------------------------------------------------- | ------------------------------------------------- | -------------------------- | ----------------------------------------- |
| `<staging-relay-fsn-ipv4>`, `<staging-relay-fsn-ipv6>`         | Cloudflare tfvars (`relays`)                      | `RELAY_IPV4`, `RELAY_IPV6` | Step 6, `tofu output relays`              |
| `<staging-d1-id>`                                              | `wrangler.jsonc` (`database_id`)                  | `D1_DATABASE_ID`           | Step 7, `tofu output d1_database_id`      |
| `<staging-standard-product-id>`, `<staging-standard-price-id>` | `wrangler.jsonc` (`BILLING_PLANS`, commented out) | Left on purpose            | Stripe test mode, only when billing is on |

Later, with CI (I-03), these go into GitHub environments, not files ([deploy runbook, GitHub settings](runbooks/deploy.md#github-settings)): `staging` gets the `CLOUDFLARE_API_TOKEN` secret (the deploy token) and the variables `CLOUDFLARE_ACCOUNT_ID` and `RELAY_HOSTS` (`relay-fsn.ptbk.link`); `release` gets `UI_STAGING_RELEASE_KEY`, `UI_STAGING_R2_ACCESS_KEY_ID` and `UI_STAGING_R2_SECRET_ACCESS_KEY`, plus the variables `UI_STAGING_R2_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`) and `UI_STAGING_R2_BUCKET`.

**You should see:** `git diff` touches only the staging files; `--check` lists only the placeholders left on purpose, plus the relay addresses and the D1 ID until steps 6 and 7.
**If it fails:** `<KEY> must be …` names the value in `staging.env` to fix.

## 6. Relay host: create

The Cloudflare stack needs the relay's addresses, so the host is created first. Its secrets and certificate come in step 10. Details: [infra/relay README](../infra/relay/README.md#create-a-host).

```sh
cd infra/relay/environments/staging
export HCLOUD_TOKEN=…                                       # step 1.3
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…          # the state bucket's R2 token
export TF_VAR_state_passphrase=…
tofu init
tofu plan -out=tfplan                                       # a firewall, two primary IPs, one server
tofu apply tfplan
tofu output relays                                          # into staging.env: RELAY_IPV4, RELAY_IPV6
```

Then run `node scripts/staging/fill-placeholders.ts` again, and add both addresses to the `ptbk-staging-acme-dns` token's client IP filter.

**You should see:** server `relay-fsn` in `fsn1` in the Hetzner project, with an IPv4 and an IPv6 primary IP. The first boot takes a few minutes (packages, hardening, maybe a reboot). `ssh seb@<ipv4>` works from any network, with the committed key.
**If it fails:** a validation error that names a `<...>` placeholder means the fill script has not run on this branch. A 403 from `tofu init` means the R2 token or the account ID is wrong (step 3).

## 7. Cloudflare stack

```sh
cd infra/cloudflare/environments/staging
export CLOUDFLARE_API_TOKEN=…                               # ptbk-staging-iac
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…          # the same R2 token as step 6
export TF_VAR_state_passphrase=…
tofu init
tofu plan -out=tfplan
tofu apply tfplan
tofu output                                                 # d1_database_id into staging.env, then fill again
```

The plan should only add: the D1 database `ptbk-dashboard-staging`, the email sending subdomain, the custom domain `ui.ptbk.link` on `ptbk-ui-releases-staging` with its r2.dev access off, the custom hostname `app.ptbk.io` with the zone's fallback origin `app-origin.ptbk.link`, and DNS records in `ptbk.link`. The records are the wildcard `*.engines.ptbk.link` A and AAAA (TTL 30), `relay-fsn` A and AAAA, three CAA, the null MX, SPF and DMARC on `engines.ptbk.link`, DMARC on the sending domain, and `app-origin` AAAA `100::`, the only proxied one. No zone, no zone setting (Universal SSL, DNSSEC) and no ACME CNAME: staging has no engine zone or challenge zone. It must destroy nothing.

Then `tofu output dashboard_owner_records` lists the records for the `ptbk.io` owner. Send him the two marked `now` ([DNS records for the ptbk.io owner](#dns-records-for-the-ptbkio-owner)); the `cutover` one waits for step 8.

No NS or DS records to set: `ptbk.link` is already on Cloudflare's name servers, and staging has no DNSSEC.

**Verify** (the staging form of [infra/cloudflare README, Verifying an environment](../infra/cloudflare/README.md#verifying-an-environment)):

```sh
zone=ptbk.link
ns=$(dig +short NS $zone | head -1)
dig +short A anything.engines.$zone @$ns         # the relay's IPv4
dig +short AAAA anything.engines.$zone @$ns      # the relay's IPv6
dig +short A engines.$zone @$ns                  # empty
dig +short CAA engines.$zone @$ns                # issue "letsencrypt.org", issuewild ";", iodef, and nothing else
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/c203cd9d66f14a374dbdd2df74f6380a/dns_records?proxied=true&per_page=100" \
  | jq '[.result[].name | select(endswith(".engines.'$zone'"))]'   # []
```

Once the owner has added the two records, SSL/TLS, Custom Hostnames in `ptbk.link` shows `app.ptbk.io` with hostname status **Active** and certificate status **Active** (minutes to an hour), and the fallback origin **Active**. Check at this first apply, and record in [infra/cloudflare README, Dashboard on another account's zone](../infra/cloudflare/README.md#dashboard-on-another-accounts-zone): that the DCV Delegation target shown there matches the `_acme-challenge` record the output gave (`app.ptbk.io.<uuid>.dcv.cloudflare.com`), and that the certificate issued under `ptbk.link`'s settings.

**You should see:** every check above as commented. If `CAA` lists more than our three records, Cloudflare added its own for Universal SSL: record it in [infra/cloudflare README, Staging: one domain](../infra/cloudflare/README.md#staging-one-domain).
**If it fails:** an error on the email sending subdomain means Email Service is not enabled yet, or the IaC token lacks its permission. `cloudflare_zone.dashboard` not found means `ptbk.link` is not in this account, or the IaC token is not scoped to it.

## 8. Dashboard

The manual equivalent of `deploy-dashboard.yml`'s staging job ([deploy runbook, Dashboard](runbooks/deploy.md#dashboard)). It runs from the values branch, after the D1 ID has been filled in.

```sh
cd apps/dashboard
bun run generate
CLOUDFLARE_ENV=staging bun run build                        # bakes the staging environment in
export CLOUDFLARE_API_TOKEN=…                               # ptbk-staging-deploy
export CLOUDFLARE_ACCOUNT_ID=42b20127fa7293cb5160f22ed42ef43b
bunx wrangler d1 migrations apply DB --env staging --remote
bunx wrangler deploy --env staging --message "manual $(git rev-parse --short HEAD)"
bunx wrangler secret put RATE_LIMIT_HMAC_KEY --env staging   # paste at the prompt, from the password manager
bunx wrangler secret put MEMBER_KEY --env staging
bunx wrangler secret put RELAY_METRICS_TOKENS --env staging
bunx wrangler secret put ANALYTICS_API_TOKEN --env staging   # the ptbk-staging-analytics token
edge=$(dig +short A app-origin.ptbk.link | head -1)          # Cloudflare's edge, before app.ptbk.io points there
curl -sS --resolve app.ptbk.io:443:$edge https://app.ptbk.io/v1/health
```

Then ask the `ptbk.io` owner for the `cutover` record ([DNS records for the ptbk.io owner](#dns-records-for-the-ptbkio-owner)), and once `dig +short CNAME app.ptbk.io` answers `app-origin.ptbk.link.`:

```sh
node scripts/smoke-test.ts --origin https://app.ptbk.io --environment staging
```

Deploy first and put the secrets after: on a Worker that does not exist yet, `secret put` would offer to create an empty one. Each `secret put` deploys a new version.

Then check the deploy token's scope, as CI will use it ([infra/cloudflare README, API tokens](../infra/cloudflare/README.md#api-tokens)). From the repo root, with `ptbk.link`'s zone ID (`tofu output staging_zone_id` in step 7 must print the same); it holds the engine records too:

```sh
CLOUDFLARE_API_TOKEN=<deploy token> CLOUDFLARE_ACCOUNT_ID=42b20127fa7293cb5160f22ed42ef43b \
  infra/cloudflare/scripts/verify-deploy-token.sh c203cd9d66f14a374dbdd2df74f6380a
```

**You should see:** every migration applied; `wrangler deploy` listing `app.ptbk.io/* (zone name: ptbk.link)`; the `curl` answering `staging` with a valid certificate before the cutover; the smoke test passing (`/v1/health` answers `staging`, and `/` is the SPA shell under the production CSP); the dashboard loading in a browser; the token check reporting Workers and D1 reachable, and DNS read and write refused in the staging zone. Paste its output into the values PR.
**If it fails:** an error resolving `zone_name` or creating the route means the deploy token needs more than Workers Routes Edit for it (likely Zone Read on `ptbk.link`, never DNS); or replace the route's `zone_name` with `"zone_id": "c203cd9d66f14a374dbdd2df74f6380a"`, which needs no lookup. A `curl` that gets no Worker answer means the custom hostname or its certificate is not Active yet (step 7). Record the exact permission in infra/cloudflare/README.md, add it, and rerun the token check (the README asks for this), or deploy this once after `bunx wrangler login` as yourself. If `/v1/health` answers 500, `bunx wrangler tail --env staging` shows `Invalid dashboard configuration:` with the names of the missing or invalid vars and secrets (never their values).

## 9. Test email

1. Sign up at `https://app.ptbk.io/` with an outside mailbox (Gmail, for example) and finish with your passkey. With billing off, no Checkout comes next.
2. In the verification email, open the original message: the headers must show `spf=pass`, `dkim=pass` and `dmarc=pass` for the sending domain. Paste the `Authentication-Results` lines into the values PR (I-02's email check, which also covers D-02 and D-05).
3. Set `dmarc_policy = "reject"` in `infra/cloudflare/environments/staging/terraform.tfvars`, then plan (one in-place change to the DMARC TXT record) and apply as in step 7.

**You should see:** the mail within a minute, passing all three checks.
**If it fails:** if no mail arrives, `bunx wrangler tail --env staging` shows the send failure, and a sending domain that Cloudflare has not verified yet usually needs a few minutes more. `dmarc=fail` with `spf=pass` means `EMAIL_FROM` is not on the sending domain.

## 10. Relay: secrets, certificate, registration

The relay reads its registry from `https://app.ptbk.io`, so this needs step 8's cutover. Mint the relay's registry token in D1 (D-04). The deploy token from step 8 is still exported:

```sh
cd apps/dashboard
node scripts/mint-relay-key.ts --relay relay-fsn.ptbk.link --env staging   # prints the token once
```

Store it in the password manager. Then place the three credentials without writing them to disk: copy each one from the password manager and pipe it from the clipboard (macOS):

```sh
cd ../..
host=relay-fsn.ptbk.link
pbpaste | ssh <admin>@$host 'sudo install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/registry-token'   # the minted token
pbpaste | ssh <admin>@$host 'sudo install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/metrics-token'    # from step 4
pbpaste | ssh <admin>@$host 'sudo install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/acme-dns-token'   # ptbk-staging-acme-dns
pbcopy < /dev/null
ssh <admin>@$host 'sudo systemctl start ptbk-relay-cert.service; sudo journalctl -u ptbk-relay-cert --no-pager | tail -20'
ssh <admin>@$host 'sudo ls -l /etc/ptbk-relay/credentials'
infra/relay/verify.sh <admin>@$host
```

From outside (a phone hotspot, for example), `nmap -Pn -p- $host` must show only 22 and 443.

**You should see:** lego reports a certificate for `relay-fsn.ptbk.link`; `tls.crt` and `tls.key` appear next to the three tokens, all `-rw------- root`. `verify.sh` passes every host check. Before the image runs, the relay checks fail (`ptbk-relay.service is active`, the uid, the capabilities), as the script itself says they should before the first deploy.
**If it fails:** if lego cannot find the zone or gets a 403, the ACME token is not on `ptbk.link` (or lacks Zone Read), or the client IP filter lacks the relay's addresses. A leftover `_acme-challenge.relay-fsn` CNAME in the zone sends lego elsewhere: delete it. If SSH is refused, your key is not the one in `admins`; changing it needs a rebuild.

**The relay image: blocked until CI runs.** A relay host runs only an image whose cosign signature names `release-relay.yml` on `main` of `webgptorg/app`, through GitHub's OIDC issuer, with a Rekor entry and a timestamp ([deploy runbook, Relay](runbooks/deploy.md#relay)). Only that workflow on GitHub Actions can produce such a signature, so there is no manual deploy that keeps the check. Until it runs, the relay service does not start, and browsers cannot reach engines. Staging waits for Actions: there is no staging exception for unsigned images (decided 2026-11-04).

Once Actions runs, create the GHCR machine account and its `read:packages` token, place it as `registry-auth` ([infra/relay README, Create a host](../infra/relay/README.md#create-a-host), step 3), set the `staging` environment's `RELAY_HOSTS`, and let `release-relay.yml` roll the image out. Then rerun `verify.sh`: `all checks passed`.

## 11. UI release: prepare now, publish with CI

Now: the staging release key's public half goes into `trust-policy.staging.json` (step 4, in the values PR), the bucket exists (step 3), and the stack serves it as `https://ui.ptbk.link/` (step 7, the `ui_release_url` output), which engines get as `PTBK_UI_RELEASE_URL`.

A real release needs `ui-release.yml` on a pushed `ui-v*` tag: its provenance is a keyless signature through GitHub OIDC, which `release:verify` and every engine require ([development.md, UI releases](development.md#ui-releases)). Once Actions runs, create the UI release R2 token (step 2), fill in the `release` environment (step 5's last table), and push `ui-v0.0.0-dryrun.1` ([apply.md](plan/apply.md) step 3).

Engines install nothing without a fresh signed revocation list, so publish the first one now, before any release, from your machine and signed with the staging release key ([development.md, Revocation list](development.md#revocation-list)):

```sh
read -rs UI_RELEASE_KEY && export UI_RELEASE_KEY   # the UI_STAGING_RELEASE_KEY seed from the password manager
bun run --filter @ptbk/engine-ui release:revocations --first
unset UI_RELEASE_KEY
(cd apps/dashboard && bunx wrangler r2 object put ptbk-ui-releases-staging/release-log/revocations.json --remote \
  --file ../engine-ui/release/revocations.json --content-type application/json --cache-control no-cache)
```

**Re-sign it every 14 days** (each list is valid for 30), and at once when a version must be revoked (`--revoke <version>="<reason>"`). From then on, fetch the published list and pass it as `--previous` instead of `--first`:

```sh
(cd apps/dashboard && bunx wrangler r2 object get ptbk-ui-releases-staging/release-log/revocations.json \
  --remote --file /tmp/revocations.prev.json)
read -rs UI_RELEASE_KEY && export UI_RELEASE_KEY
bun run --filter @ptbk/engine-ui release:revocations --previous /tmp/revocations.prev.json
unset UI_RELEASE_KEY
# then the same wrangler r2 object put as above
```

Put the next re-sign date in the calendar: once a list expires, engines install nothing new (they keep their current UI and alert). Never upload an older list again: engines refuse it as rolled back.

**You should see:** `curl -s https://ui.ptbk.link/release-log/revocations.json` returns the envelope (`"payloadType": "application/vnd.ptbk.revocation+json; v=1"`), and the command printed an `expires` 30 days after `issued`. Until a release is published, an engine's `/` answers the plain 503 page.
**If it fails:** `release:revocations` refusing the key means the seed is not the one in `trust-policy.staging.json`. A 404 from `ui.ptbk.link` with the object in the bucket means the custom domain is not active yet (R2, the bucket's Settings, Custom Domains).

## 12. Link an engine

The real engine is the engine team's `ptbk` CLI (npm `ptbk`; Node 22.13+ or 24+, npm 10+, Git and Chrome). Link only a throwaway project with test data ([Staging relaxations](#staging-relaxations-not-for-production)). Engines, New engine shows these commands with the link URL filled in, as its first tab:

```sh
npm install --global ptbk
mkdir -p my-agenda && cd my-agenda
ptbk init --path . --no-dashboard
ptbk connect --link 'https://app.ptbk.io/link#<code>'
```

The link URL names the dashboard, so no variable is needed; the engine prints `https://app.ptbk.io` before it registers, keeps it with the registration and uses it after a reboot too. This needs a `ptbk` release that takes the link URL (the engine team's 2026-11-06 change). With 0.119.0-72, link with the code after `#` and the old variables instead, and start the engine from a shell that has them:

```sh
export PTBK_DASHBOARD_URL=https://app.ptbk.io PTBK_ENGINE_DOMAIN=engines.ptbk.link
ptbk connect --link <code>
```

**You should see:** "Linked to the Promptbook App" with the engine ID and the fingerprint the page shows; the engine shows online within about a minute, with its relays connected. "Open" does not work yet: the engine refuses browser streams until it terminates TLS itself, and its App page says so.

The mock engine checks the path through the relay end to end. On your machine:

```sh
bun run --filter @ptbk/mock-engine build
mkdir -m 700 -p ~/.ptbk-staging-engine
export PTBK_DATA_DIR=~/.ptbk-staging-engine PTBK_ENGINE_DOMAIN=engines.ptbk.link
node apps/mock-engine/dist/main.mjs connect --link '<link URL>'  # from Engines, New engine
node apps/mock-engine/dist/main.mjs                              # runs the engine: tunnels, heartbeats
```

**You should see:** `connect` exits 0 and prints the engine ID and the fingerprint the page shows; the page's checklist moves on; the engine shows online after its first heartbeat (within about a minute). Once the relay runs (step 10), the engine reports `relays.connected`, the dashboard says "Reachable through 1 relay", and the path through the relay is end to end:

```sh
curl -sk https://<engineId>.engines.ptbk.link/__spike/whoami
openssl s_client -connect <relay ipv4>:443 -servername <engineId>.engines.ptbk.link </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer                # the engine's own dev CA, never Cloudflare's or the relay's
```

The mock's certificate comes from its dev CA, so browsers warn. A CA-issued certificate through the relay is the Let's Encrypt **staging** run in [spike/acme-tls-alpn-01.md](spike/acme-tls-alpn-01.md#runbook-lets-encrypt-staging-manual) ([apply.md](plan/apply.md) step 10); never against Let's Encrypt production.

**If it fails:** for `ptbk`, the message names the refusal and the next step. For the mock, exit 3 means the code was refused (used, cancelled, or older than 30 days): make a new one. Exit 5 (`engine-limit`, `not-entitled`) means the organization already has `BILLING_OFF_PLAN`'s 10 engines (revoke one), or billing is not off. Exit 6 means the dashboard was unreachable.

## 13. e2e against staging

Not supported yet. The e2e suite runs only against its own Docker Compose stacks ([development.md, End to end](development.md#end-to-end)), and nothing points it at a remote dashboard or relay. The checks in steps 7 to 12 stand in for it. I-01's Apply criterion ("the e2e or spike suite runs green against the staging relay") stays open until a remote target exists and the relay runs.

## 14. Teardown and reset

- **The `ptbk` engine:** `ptbk disconnect` and `ptbk stop` in its project, then delete the engine in the dashboard.
- **The mock engine:** stop it, `rm -rf ~/.ptbk-staging-engine`, and delete the engine in the dashboard.
- **Dashboard data, from scratch:** `bunx wrangler delete --env staging` removes the Worker with its Durable Objects and secrets. The D1 database has `prevent_destroy`, so delete it in the Cloudflare dashboard (D1, `ptbk-dashboard-staging`, Settings), then `tofu state rm 'module.environment.cloudflare_d1_database.dashboard'` in `infra/cloudflare/environments/staging`, and plan and apply to create it again. Then put its new ID into `staging.env`, fill, open a PR, and repeat step 8, secrets included.
- **Rebuild the relay host:** `tofu apply -replace='module.environment.hcloud_server.relay["relay-fsn"]'`, then step 10 again (the primary IPs stay, so DNS does not change; [infra/relay README, Rebuild a host](../infra/relay/README.md#rebuild-a-host)).
- **Remove the relay:** lift the primary IPs' delete protection in the Hetzner Console, then `tofu destroy` in `infra/relay/environments/staging`. The Cloudflare stack refuses to plan without a relay, so leave its records.
- **Everything:** the above; delete the four account tokens, the R2 token and `HCLOUD_TOKEN`; empty and delete both buckets; delete the Hetzner project. Leave `ptbk.link` and the rest of the shared account alone; `tofu destroy` in `infra/cloudflare/environments/staging`, after the D1 database is out of its state, removes staging's records from the zone.
- **A token or secret that leaked:** [deploy runbook, If a credential leaks](runbooks/deploy.md#if-a-credential-leaks) and [infra/relay README, Rotate secrets](../infra/relay/README.md#rotate-secrets).

## DNS records for the ptbk.io owner

`ptbk.io` is in the engine team's Cloudflare account (registrar Gransy). We hold no token for it; its owner adds exactly these records, all **DNS-only (grey cloud)**, nothing else. Values come from `tofu output dashboard_owner_records` after step 7. `ptbk.io` has a wildcard `*.ptbk.io` CNAME, which explicit records override.

| When                | Type  | Name                                     | Value                                                     |
| ------------------- | ----- | ---------------------------------------- | --------------------------------------------------------- |
| After step 7        | CNAME | `_acme-challenge.app.ptbk.io`            | `app.ptbk.io.<uuid>.dcv.cloudflare.com` (from the output) |
| After step 7        | TXT   | `_cf-custom-hostname.app.ptbk.io`        | The ownership value from the output                       |
| Only when we say so | CNAME | `app.ptbk.io` (replaces `CNAME ptbk.io`) | `app-origin.ptbk.link`                                    |

1. **Now:** the first two. The CNAME delegates certificate validation to Cloudflare, so renewals need nobody; it stays for as long as the dashboard is on `app.ptbk.io`. The TXT proves the hostname is ours before any traffic moves; he may delete it once the custom hostname is Active.
2. **Cutover, only when we ask** (step 8, after the `curl` check): he replaces today's `app` CNAME (to `ptbk.io`, the Vercel site) with the CNAME to `app-origin.ptbk.link`. It must stay DNS-only: proxied, his zone's settings would apply first (orange-to-orange), which pre-validation does not support.
3. **No mail records:** the dashboard sends from `mail.ptbk.link`. Cloudflare Email Service sends only from a zone in its own account, so `ptbk.io`'s MX, SPF and DMARC stay as they are.

Rollback: he points `app` back to `ptbk.io`.

## Next: CI

Once GitHub Actions runs and the plan has environments (I-03): create `staging` and `release` as in [deploy runbook, GitHub settings](runbooks/deploy.md#github-settings), with the values from step 5. Then run [apply.md](plan/apply.md) steps 3, 6 and 7.

Pushes to `main` deploy nothing until you switch them on, so CI minutes are not spent on a target that does not exist. Once the `staging` environment has its secrets and variables:

1. Repository Settings, Secrets and variables, Actions, **Variables** tab: add the repository variable `STAGING_DEPLOY_ENABLED` with the value `true` (or `gh variable set STAGING_DEPLOY_ENABLED --body true`).
2. Dispatch **Deploy dashboard** and **Release relay** from `main` once, and check that both reach staging. Their production jobs wait for approval; reject them if you only meant staging.

From then on, a push to `main` that touches the dashboard deploys it to staging, `release-relay.yml` builds, signs and rolls the relay out, and `ui-release.yml` dry-runs the UI. Production still waits for its approval. To pause deploys on push again, delete the variable or set it to anything else. The variable only switches the push trigger on: a dispatch from `main` deploys whatever it says, and environments, approvals, signing and permissions are the same either way.
