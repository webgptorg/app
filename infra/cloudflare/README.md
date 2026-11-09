# infra/cloudflare

DNS and Cloudflare resources for staging and production, as OpenTofu stacks ([ADR 0011](../../docs/adr/0011-infrastructure-as-code.md)). Task I-02.

Per environment, in that environment's Cloudflare account (production's own; staging shares an existing account and runs on one domain, see [Staging: one domain](#staging-one-domain)):

| What                                                                                       | Notes                                                                                                             |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Engine domain zone (created and owned here; none on staging)                               | Used for nothing else; DNSSEC on; Universal SSL off                                                               |
| `*.<engine domain>`: every relay in rotation, health-checked or plain (`relay_dns_mode`)   | DNS-only, TTL 30 s (load balancer) or 60 s (A and AAAA records), see Relay DNS below (I-07)                       |
| CAA on the engine domain                                                                   | `0 issue "letsencrypt.org"`, `0 issuewild ";"`, `0 iodef "mailto:<security contact>"`                             |
| No-mail records on the engine domain                                                       | Null MX, `v=spf1 -all`, DMARC `p=reject`: nothing may send mail as it                                             |
| `_psl.<engine domain>` TXT, once `psl_pull_request` is set                                 | The Public Suffix List pull request's URL, which the PSL maintainers check (I-05)                                 |
| `<relay>.<relay domain>` A and AAAA for every relay                                        | DNS-only, TTL 60 s; stays while a relay is out of rotation                                                        |
| D1 database `ptbk-dashboard-<env>`                                                         | Location hint `weur`; its ID goes into `apps/dashboard/wrangler.jsonc`                                            |
| Email Service sending domain in the dashboard zone, plus its DMARC record                  | Cloudflare publishes SPF, DKIM and return-path records for it; DMARC is ours                                      |
| Records added to the dashboard zone (`ptbk.io` in production), which is not owned here     | Its other records (website, MX) stay outside this stack                                                           |
| With `ui_releases` (staging: `ui.ptbk.link`): the UI release bucket's custom domain        | TLS 1.2+, r2.dev off; the bucket is created by hand; `ui_release_url` is engines' `PTBK_UI_RELEASE_URL`           |
| With `dashboard_custom_hostname` (staging: `app.ptbk.io`): the dashboard's custom hostname | Cloudflare for SaaS on the dashboard zone, with its fallback origin; [below](#dashboard-on-another-accounts-zone) |

The dashboard Worker and its routes are deployed by wrangler from `apps/dashboard/wrangler.jsonc` (I-03), not from here: production's custom domain `app.ptbk.io`, and staging's route `app.ptbk.io/*` on `ptbk.link` ([Dashboard on another account's zone](#dashboard-on-another-accounts-zone)).

## Layout

```
modules/environment/         Everything above, plus the rules (preconditions and validations); relay-dns.tf is the
                             engine wildcard (load balancer or records)
modules/environment/tests/   tofu test with a mocked provider: offline, no account or token
environments/staging/        Backend, state encryption, provider; values in terraform.tfvars
environments/production/     The same for production
scripts/verify-deploy-token.sh  Checks a deploy token's scope against the table below
```

## Rules the code enforces

Each fails `tofu plan` before anything changes, and each has a case in `modules/environment/tests/`:

- No record under the engine domain is proxied, matched by name in whatever zone it is declared. Proxying would make Cloudflare terminate engine TLS. The load balancer is DNS-only too (a test pins it).
- No DNS record on `*.<engine domain>` but `relay-dns.tf`'s own: a record next to the load balancer would be served unchecked whenever it is off, and one next to the plain records could list a relay out of rotation.
- `relay_dns_mode = "load_balancer"` needs at least two relays (with one, the fallback pool always lists it, so a load balancer costs money and drops nothing) and `ops_email`.
- No A, AAAA, CNAME, HTTPS or SVCB record on the bare engine domain.
- At least one relay stays in rotation.
- The UI release hostname is inside the dashboard zone and never the engine domain or under it, where Cloudflare would hold a certificate for an engine hostname.
- The relay health check runs every 10 to 60 seconds from at least three distinct regions.
- Every record is inside its zone; relay hostnames are inside the engine or dashboard zone.
- The sending domain is inside the dashboard zone and never under the engine domain.
- The dashboard's custom hostname is outside the dashboard zone (a name inside it is a custom domain) and never the engine domain or under it; its fallback origin is inside the dashboard zone and never under the engine domain. That fallback origin is the only proxied record the stack makes.
- Placeholders (`<...>`) and malformed values are refused.
- `engine_zone_mode = "subdomain"` only outside production, only for an engine domain under the dashboard zone, and never with a `psl_pull_request`.

Every DNS record goes through the single `cloudflare_dns_record.this` resource, so the rules cover records added later. The engine wildcard's load balancer in `relay-dns.tf` is the one exception. A new DNS resource elsewhere in the stack is a review finding.

Universal SSL is off on the engine zone: with it on, Cloudflare would hold a certificate for `*.<engine domain>` and add CAA records for its own CAs, undoing `issuewild ";"`. The engine zone and the D1 database have `prevent_destroy`.

## Placeholders

Nothing can be applied yet. These wait on the decisions in the plan's "Still needed" table:

| Placeholder                             | File                                                           | Decided by                                                                      |
| --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `<production-account-id>`               | `terraform.tfvars`, backend endpoint in `main.tf`              | Production's own account (team); staging's shared account ID is committed       |
| `<engine-domain>`                       | production `terraform.tfvars`, `apps/dashboard/wrangler.jsonc` | Engine domain name (team); staging's is `engines.ptbk.link`                     |
| `<relay-domain>`                        | production `terraform.tfvars`                                  | Relay hostnames under the engine domain or under `ptbk.io`                      |
| `<email-sending-domain>`                | production `terraform.tfvars`                                  | Sending subdomain (D-02 sets the from address); staging's is `mail.ptbk.link`   |
| `<security-contact>`                    | `terraform.tfvars`                                             | Security mailbox (with I-05's abuse address)                                    |
| `<ops-email>`                           | production `terraform.tfvars`                                  | Ops mailbox (I-04's alerts); Cloudflare's relay health notifications go there   |
| `psl_pull_request` (unset)              | production `terraform.tfvars`                                  | The PSL pull request, opened once the engine domain is applied (I-05's runbook) |
| Relay addresses                         | `terraform.tfvars`                                             | I-01 outputs                                                                    |
| `<staging-d1-id>`, `<production-d1-id>` | `apps/dashboard/wrangler.jsonc`                                | `d1_database_id` output after the first apply                                   |

For staging, `scripts/staging/fill-placeholders.ts` fills all of these, and the relay stack's, from one local `staging.env` ([staging runbook](../../docs/staging-runbook.md#5-placeholders)).

`wrangler.jsonc` names relays `relay-1.…`; when the relay domain is decided, its `RELAYS` list takes the `relay_hostnames` output instead.

## Bootstrap (once per environment)

1. Production: create its own Cloudflare account and harden it (below), with `ptbk.io` in it. Staging: use the existing account it shares and check that you have access; its zone `ptbk.link` is already there. Never `ptbk.io`, because a zone lives in one account and staging's tokens must never reach production ([Staging: one domain](#staging-one-domain)). An environment with `relay_dns_mode = "load_balancer"` (production) needs the Load Balancing add-on before its first apply (Relay DNS below has the price note); staging starts with `"records"` and needs none.
2. Create the R2 bucket `ptbk-tofu-state-<env>` in that account and an R2 API token with Object Read & Write on that bucket only.
3. Generate the state passphrase (at least 32 random characters) and store it in the team password manager. Losing it means rebuilding state by import.
4. Create the IaC and deploy tokens (below).
5. Replace the placeholders, then plan and apply (below).
6. Production, at the registrar: set the engine domain's name servers to `engine_name_servers` and add the `dnssec_ds` record. DNSSEC is in effect only once the DS record is published; record the result under DNSSEC status. Staging has no engine zone, so nothing to do here.
7. Put `d1_database_id` into `apps/dashboard/wrangler.jsonc` for the environment, in a dashboard PR.

## Running

Humans run plan and apply, from an up-to-date `main` only; CI holds no IaC credential.

```sh
cd infra/cloudflare/environments/staging
export CLOUDFLARE_API_TOKEN=...          # staging IaC token
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # R2 token for the state bucket
export TF_VAR_state_passphrase=...
tofu init
tofu plan -out=tfplan                    # the plan file is encrypted too
tofu apply tfplan
```

Before every infra PR, offline and without credentials:

```sh
cd infra/cloudflare
tofu fmt -recursive -check
for d in environments/staging environments/production modules/environment; do (cd $d && tofu init -backend=false && tofu validate); done
(cd modules/environment && tofu test)
```

A provider upgrade: pick a version at least 7 days old, bump it in all three `required_providers` blocks, then refresh the locks with `tofu providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64` in each directory.

## API tokens

Account-owned tokens (not tied to a member), one set per environment, created by hand: managing tokens from code would need a token that can mint any token. Staging is the exception: nobody handling it is Administrator in the shared account, so its tokens are user-owned, with the same scopes ([staging runbook, step 2](../../docs/staging-runbook.md#2-api-tokens)). Cloudflare cannot scope Workers or D1 permissions to one script or database, so "the dashboard only" holds in production because its account contains nothing else. Staging's account is shared, so there its Workers and D1 tokens reach every Worker and database in it ([Staging: one domain](#staging-one-domain)).

| Token                      | Used by                                          | Permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Never                                                               |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ptbk-<env>-iac`           | Humans running this stack; password manager only | Account: D1 Edit, and the Email Service sending permission (confirm its exact name when the account exists). Account: Load Balancing: Monitors and Pools Edit, Notifications Edit. Zone (all zones in the account): Zone Edit (to create the engine zone), DNS Edit (records, DNSSEC), SSL and Certificates Edit (Universal SSL), Load Balancers Edit. Staging, which has no engine zone: Zone Read, DNS Edit, SSL and Certificates Edit (the dashboard's custom hostname, fallback origin and DCV delegation ID; confirm at the first apply that it covers them) and Load Balancers Edit on its one zone only, and Account: Workers R2 Storage Edit for `ui_releases` (it reaches every bucket in the shared account) | Workers, API tokens, members, billing. Never in CI, never on a host |
| `ptbk-<env>-deploy`        | `wrangler deploy` and D1 migrations in CI (I-03) | Account: Workers Scripts Edit (includes Durable Objects), D1 Edit; no Account Settings Read, since `CLOUDFLARE_ACCOUNT_ID` names the account. Zone (dashboard zone only): Workers Routes Edit, for the custom domain or route in `wrangler.jsonc`, and Zone Read where the route names its zone by `zone_name` (staging)                                                                                                                                                                                                                                                                                                                                                                                               | Any DNS, zone or SSL permission; the engine zone                    |
| R2 `ptbk-tofu-state-<env>` | Humans running this stack                        | Object Read & Write on that bucket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Any other bucket                                                    |

In production, relays hold no credential for the engine zone or the dashboard zone. Their only Cloudflare credential is a token with Zone Read and DNS Edit on the ACME challenge zone, a zone that serves nothing else, for their own certificates (I-01, [ADR 0011](../../docs/adr/0011-infrastructure-as-code.md)). The dashboard Worker reaches D1 and email through bindings, not tokens. A DNS credential for the engine domain on a relay would let a compromised relay obtain certificates for engine hostnames. Staging accepts exactly that: its relay's token edits the one staging zone, engines included ([Staging: one domain](#staging-one-domain)).

Workers Routes Edit lets the deploy token attach the dashboard Worker to hostnames in the dashboard zone, which can affect availability but not DNS records or certificates. If the first deploy shows wrangler needs more for the custom domain, record the exact permission here and rerun the check.

Verify every new or rolled deploy token, and paste the output into the PR or the rotation note:

```sh
CLOUDFLARE_API_TOKEN=<deploy token> CLOUDFLARE_ACCOUNT_ID=<account> scripts/verify-deploy-token.sh <engine zone id> <dashboard zone id>
```

It must report Workers and D1 reachable and DNS read and write refused in both zones (on staging, pass the staging zone ID once: it is both). Rotate tokens at least yearly and at once when someone with access leaves; the procedure for a leaked token is in I-03's deploy runbook.

## Account hardening

These apply in full to production's account. Staging's shared account is run by its owner; there, check only that everyone who handles staging has their own login with two-factor authentication on.

- **Members:** as few as possible. Two named maintainers are Super Administrators; anyone else gets a scoped role. Remove members the day they leave.
- **Two-factor:** turn on "Enforce two-factor authentication" for the account. Every member registers at least two hardware security keys and no authenticator app or SMS. Cloudflare cannot enforce the factor type, so the monthly review confirms it with each member.
- **Registrar** (engine domain and `ptbk.io`): transfer lock on, hardware-key 2FA on the registrar account, DS record published.
- **Audit log review**, monthly and after every incident, in each account (Manage Account, Audit Log), by a maintainer who records the date and findings in the team's ops log:
  - API tokens created, rolled or re-scoped; members added or roles changed;
  - DNS or zone setting changes that match no merged PR (Universal SSL, proxy status, DNSSEC);
  - then `tofu plan` in each environment must show no changes; any drift is investigated before it is overwritten.

## Staging: one domain

Decided by Seb on 2026-11-06, for staging only: one domain, `ptbk.link`, in an existing, shared Cloudflare account instead of a fresh account and three registrable domains. Production is unchanged. With `<d>` = `ptbk.link`:

| Name                            | What                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `app-origin.<d>`                | Fallback origin of the dashboard's custom hostname `app.ptbk.io`; the one proxied record              |
| `relay-fsn.<d>`                 | The relay's hostname (`relay_domain = <d>`)                                                           |
| `mail.<d>`                      | Email sending subdomain, with its DMARC record                                                        |
| `*.engines.<d>`                 | Engine hostnames: DNS-only wildcard to the relay, TTL 60 s; `engines.<d>` has CAA and no-mail records |
| `_acme-challenge.relay-fsn.<d>` | The TXT record lego writes for the relay's certificate, directly: no CNAME, no challenge zone         |

The staging root sets `engine_zone_mode = "subdomain"` and `engine_domain = "engines.<dashboard_zone>"`. In that mode the module creates no engine zone and touches no zone-wide setting of the shared zone (Universal SSL, DNSSEC); every engine record goes into the dashboard zone, and every rule above still applies to it by name. The module refuses the mode in production, for an engine domain outside the dashboard zone, and with a PSL pull request. Why it is an explicit switch rather than derived from the names: an engine domain under `ptbk.io` must never quietly lose its own zone, DNSSEC and PSL entry.

What staging gives up, and why that is acceptable there: [staging runbook, Staging relaxations](../../docs/staging-runbook.md#staging-relaxations-not-for-production). **Confirm at the first staging apply:** `dig +short CAA engines.<d>` lists only the three records above. Universal SSL stays on for the shared zone, and Cloudflare may add CAA records for its own CAs where a zone has CAA records; if it adds any at `engines.<d>`, record it here.

## Dashboard on another account's zone

Decided by Seb on 2026-11-06: the one environment that becomes production (staging today) serves the dashboard on `app.ptbk.io`, the URL engines have built in. `ptbk.io` is a zone in the engine team's Cloudflare account, which we hold no token for, and a Workers custom domain needs its zone in the Worker's account. So `app.ptbk.io` is a [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) custom hostname of `ptbk.link`:

- `dashboard_custom_hostname = { hostname, fallback_origin }` creates the custom hostname (a DV certificate, `ssl.method = "txt"` for delegated DCV, TLS 1.2+), the originless fallback origin record (`AAAA 100::`, proxied) and the zone's fallback origin setting. Off by default; production's custom domain needs none of it.
- The Worker takes the traffic through a [route](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/) on the SaaS zone for that hostname only, `app.ptbk.io/*` with `zone_name = "ptbk.link"` in `wrangler.jsonc`. Not `*/*`, which would also catch `ui.ptbk.link` and the zone's other proxied names.
- The owner adds only DNS-only records, listed by the `dashboard_owner_records` output ([staging runbook, DNS records for the ptbk.io owner](../../docs/staging-runbook.md#dns-records-for-the-ptbkio-owner)). The `_acme-challenge` CNAME delegates DCV to Cloudflare, so certificates renew without him; the `_cf-custom-hostname` TXT pre-validates the hostname, so it is active before traffic moves. The `app` CNAME stays DNS-only: proxied, his zone's settings would apply first (orange-to-orange), and pre-validation does not support that.
- The SaaS plan includes 100 custom hostnames on every plan, Free included, then $0.10 each (checked 2026-11-06); we use one.

**Check at the first apply:** the DCV delegation target is `<hostname>.<dcv_delegation uuid>.dcv.cloudflare.com` (the docs show only "the copied hostname"; compare with SSL/TLS, Custom Hostnames, DCV Delegation); the custom hostname's certificate issues under `ptbk.link`'s settings (Universal SSL on; `ptbk.io` has no CAA); the IaC token's SSL and Certificates Edit is enough for the custom hostname and fallback origin; and the deploy token can resolve `zone_name` and create the route (if not, add Zone Read on `ptbk.link`, never DNS). Record the results here.

## Relay DNS (I-07)

With `relay_dns_mode = "load_balancer"` (production's setting), `*.<engine domain>` is a DNS-only Cloudflare load balancer (`modules/environment/relay-dns.tf`), so a relay that stops completing TLS handshakes leaves DNS by itself. Browsers fail over on their own from a relay that refuses connections or does not answer at all, but not from one that accepts TCP and then hangs: they wait for its TLS answer and never try the next address (measured in `e2e/tests/network/relay-failover.spec.ts`). Nothing at runtime holds a token for the engine zone.

- **Modes.** `"records"` (staging's setting while it has one relay) publishes plain wildcard A and AAAA records for every relay in rotation, with a 60 s TTL (plain records go no lower outside Enterprise) and no add-on: browsers still fail over from a dead relay, but a hung one stays listed until it is taken out of rotation by hand (runbook below). With one relay the load balancer could drop nothing anyway, since the fallback pool always lists it; the rules refuse `"load_balancer"` with fewer than two relays.
- **Switching from records to the load balancer** (staging once it has a second relay, or production if it started with records): buy the add-on, set `relay_dns_mode = "load_balancer"` and `ops_email`, then apply in two steps so the wildcard never goes empty. First `tofu apply -target='module.environment.cloudflare_load_balancer.engine_wildcard'`, which creates the monitor, pools, load balancer and nothing else; Cloudflare already answers from the load balancer, which takes precedence over records of the same name. Then plan (only the wildcard records are deleted and the notification policy added) and apply. Back to records is one apply; a gap of a few seconds without the wildcard is possible there.
- **Pools.** One primary pool with every relay address in rotation (IPv4 and IPv6 endpoints) at equal weight: a DNS-only load balancer then answers with every healthy endpoint of the pool, so only an unhealthy relay drops out and browsers keep retrying the next address. A fallback pool holds the same relays without a monitor and answers when no endpoint of the primary pool is healthy: a monitor that fails everywhere keeps every relay listed instead of emptying DNS.
- **Monitor.** HTTPS `GET /healthz` on each relay's own hostname (the endpoint's Host header, which the monitor also sends as the TLS server name), certificate verified, `200` and `ok` expected, 3 s timeout and one immediate retry, every `relay_health_check.interval_s` (15 s) from `relay_health_check.regions` (WEU, EEU, ENAM). A relay is unhealthy after 2 failed checks in a row and healthy after 3 passed ones, and Cloudflare counts it unhealthy only when most regions see it fail, so one region's network cannot pull it.
- **Alerts.** A notification policy emails `ops_email` on every pool and endpoint health change, sent by Cloudflare itself, so it also alerts while the dashboard is down. I-04's relay-unreachable alert covers the same relays from the dashboard's side.
- **Failover time** ≈ interval × consecutive down + TTL = 15 × 2 + 30 = 60 s (plus up to 2 × 3 s of timeouts), and longer where a resolver or operating system keeps answers past their TTL; record what production resolvers do at Apply. With 60 s checks (the cheapest tier) it is 150 s.
- **What the TTL costs.** Each resolver that serves users of an engine asks again at most every 30 s per engine hostname while it is in use: up to 2,880 queries a day per hostname and resolver, twice what I-02's 60 s cost. Cloudflare bills load-balanced DNS queries beyond the plan's allowance, so the query count, not the TTL alone, is the cost to watch: for example, 1,000 engines each used through three resolvers for eight hours a day make about 2.9 million queries a day, roughly 86 million a month.
- **Price (Apply note).** Load Balancing is a paid add-on, "starting at $5/mo" on Cloudflare's plans page (checked 2026-10-23); endpoints beyond the included ones, 15 s checks, more than one check region and DNS queries beyond the allowance cost extra. This configuration needs two endpoints per relay in each pool, 15 s checks and three regions. Price it in the dashboard's Load Balancing configurator for each account and record the monthly total in the Apply PR.

**Confirm at the first load balancer apply** (production, or staging once it has two relays), and record the results here:

1. A DNS-only load balancer on a wildcard hostname answers for any name under the engine domain (Cloudflare documents wildcard load balancer records; DNS-only with a wildcard is not stated): `dig +short A anything.<engine domain> @<name server>` lists every relay.
2. A answers carry only IPv4 endpoints and AAAA answers only IPv6 ones; with every IPv4 endpoint down and an IPv6 one healthy, what an A query gets.
3. The monitor uses the Host header as the TLS server name (the relay's certificate verifies; the endpoints show healthy).
4. With two relays (before production traffic, or on staging), pausing one (`docker pause` on the host, or `kill -STOP` the relay) removes it from `dig` within about 60 s and emails `ops_email`; resuming it brings it back and emails again. Pausing every relay keeps them all listed (fallback pool).
5. When switching from records: after the targeted apply, the load balancer, not the records, answers for the wildcard (pausing a relay drops it from `dig` as in 4) before the second apply deletes the records.

If 1 fails, the fallback is a checker that edits the relay records through the Cloudflare API, behind the `RelayDnsWriter` seam of the e2e stand-in (`e2e/src/relay-dns/checker.ts`). It needs a token that can edit the whole engine zone, held by a Worker of its own, with the relay records outside OpenTofu: a new ADR and a human decision, because that token could repoint any engine hostname (I-07, Risks).

## Runbook: a relay out of rotation

With the load balancer, a relay that fails its health check leaves the wildcard by itself (Relay DNS above); with records it does not. Take one out by hand when it is dead in records mode, for maintenance, or when it passes `/healthz` but misbehaves:

1. In `environments/<env>/terraform.tfvars`, set the relay's `in_rotation = false`. The rules refuse taking out the last one.
2. `tofu plan -out=tfplan` must show exactly two changes: with the load balancer, two in-place updates (both pools lose the relay's IPv4 and IPv6 endpoints); with records, two deletions (the relay's wildcard A and AAAA records). Its own hostname stays, so engines and I-01 can still reach it. `tofu apply tfplan`.
3. Check against Cloudflare's name servers, then a public resolver: `dig +short A anything.<engine domain> @<name server>` and the same for AAAA no longer list it.
4. Open the PR with the change right after; in an outage, apply first and merge after.

If the repo or state is unreachable, a maintainer disables the relay's endpoints in both pools in the Cloudflare dashboard (Traffic, Load Balancing, Pools), or deletes its two wildcard records in records mode, then makes the same change in code; the next plan must show no changes.

**Put it back** once it is healthy again (I-01's `verify.sh` passes, it answers on its own hostname, engines have reconnected to it): set `in_rotation = true`, plan (both pools gain its endpoints, or its two wildcard records come back), apply, and check with `dig` as above.

## Verifying an environment

For the I-02 acceptance criteria, after the first apply (paste the output into the PR):

```sh
ns=<one of engine_name_servers>
dig +short A anything.<engine domain> @$ns       # every healthy relay's IPv4 (TTL 30)
dig +short AAAA anything.<engine domain> @$ns    # every healthy relay's IPv6
dig +short A <engine domain> @$ns                # empty
dig +short CAA <engine domain> @$ns              # issue, issuewild ";", iodef
delv anything.<engine domain>                    # "fully validated" once the DS record is live
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/<engine zone id>/dns_records?proxied=true&per_page=100"   # result: []
```

Email: send a message from the staging dashboard to an external mailbox and check its headers for `spf=pass`, `dkim=pass` and `dmarc=pass`. Then set `dmarc_policy = "reject"` and apply.

### DNSSEC status

| Environment | Zone signed                     | DS at registrar | Validated (`delv`) |
| ----------- | ------------------------------- | --------------- | ------------------ |
| staging     | n/a: no engine zone (subdomain) | n/a             | n/a                |
| production  | not applied                     | no              | no                 |

## Not here

Relay hosts (I-01), deploy workflows (I-03), uptime checks and the dashboard's alerts (I-04), the PSL submission itself and the CT watch (I-05, [abuse-takedown.md](../../docs/runbooks/abuse-takedown.md#public-suffix-list)). A second DNS provider and per-engine records (with per-engine CAA `accounturi` pinning, RFC 8657) come in v1 or later.
