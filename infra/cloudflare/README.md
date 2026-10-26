# infra/cloudflare

DNS and Cloudflare resources for staging and production, as OpenTofu stacks ([ADR 0011](../../docs/adr/0011-infrastructure-as-code.md)). Task I-02.

Per environment, in that environment's own Cloudflare account:

| What                                                                                     | Notes                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Engine domain zone (created and owned here)                                              | Used for nothing else; DNSSEC on; Universal SSL off                                   |
| `*.<engine domain>`: every relay in rotation, health-checked or plain (`relay_dns_mode`) | DNS-only, TTL 30 s; a load balancer or A and AAAA records, see Relay DNS below (I-07) |
| CAA on the engine domain                                                                 | `0 issue "letsencrypt.org"`, `0 issuewild ";"`, `0 iodef "mailto:<security contact>"` |
| No-mail records on the engine domain                                                     | Null MX, `v=spf1 -all`, DMARC `p=reject`: nothing may send mail as it                 |
| `_psl.<engine domain>` TXT, once `psl_pull_request` is set                               | The Public Suffix List pull request's URL, which the PSL maintainers check (I-05)     |
| `<relay>.<relay domain>` A and AAAA for every relay                                      | DNS-only, TTL 60 s; stays while a relay is out of rotation                            |
| D1 database `ptbk-dashboard-<env>`                                                       | Location hint `weur`; its ID goes into `apps/dashboard/wrangler.jsonc`                |
| Email Service sending domain in the dashboard zone, plus its DMARC record                | Cloudflare publishes SPF, DKIM and return-path records for it; DMARC is ours          |
| Records added to the dashboard zone (`ptbk.io` in production), which is not owned here   | Its other records (website, MX) stay outside this stack                               |

The dashboard Worker, its routes and its custom domain (`app.ptbk.io`, staging `app.staging.<placeholder>`) are deployed by wrangler from `apps/dashboard/wrangler.jsonc` (I-03), not from here.

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
- The relay health check runs every 10 to 60 seconds from at least three distinct regions.
- Every record is inside its zone; relay hostnames are inside the engine or dashboard zone.
- The sending domain is inside the dashboard zone and never under the engine domain.
- Placeholders (`<...>`) and malformed values are refused.

Every DNS record goes through the single `cloudflare_dns_record.this` resource, so the rules cover records added later. The engine wildcard's load balancer in `relay-dns.tf` is the one exception. A new DNS resource elsewhere in the stack is a review finding.

Universal SSL is off on the engine zone: with it on, Cloudflare would hold a certificate for `*.<engine domain>` and add CAA records for its own CAs, undoing `issuewild ";"`. The engine zone and the D1 database have `prevent_destroy`.

## Placeholders

Nothing can be applied yet. These wait on the decisions in the plan's "Still needed" table:

| Placeholder                                                | File                                                | Decided by                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `<staging-account-id>`, `<production-account-id>`          | `terraform.tfvars`, backend endpoint in `main.tf`   | Cloudflare accounts (team)                                                        |
| `<engine-domain>`, `<staging-engine-domain>`               | `terraform.tfvars`, `apps/dashboard/wrangler.jsonc` | Engine domain name (team)                                                         |
| `<staging-zone>`                                           | staging `terraform.tfvars`                          | Staging domain; `app.staging.<placeholder>` in `wrangler.jsonc` must be inside it |
| `<relay-domain>`                                           | production `terraform.tfvars`                       | Relay hostnames under the engine domain or under `ptbk.io`                        |
| `<email-sending-domain>`, `<staging-email-sending-domain>` | `terraform.tfvars`                                  | Sending subdomain (D-02 sets the from address)                                    |
| `<security-contact>`                                       | `terraform.tfvars`                                  | Security mailbox (with I-05's abuse address)                                      |
| `<ops-email>`                                              | production `terraform.tfvars`                       | Ops mailbox (I-04's alerts); Cloudflare's relay health notifications go there     |
| `psl_pull_request` (unset)                                 | production `terraform.tfvars`                       | The PSL pull request, opened once the engine domain is applied (I-05's runbook)   |
| Relay addresses                                            | `terraform.tfvars`                                  | I-01 outputs                                                                      |
| `<staging-d1-id>`, `<production-d1-id>`                    | `apps/dashboard/wrangler.jsonc`                     | `d1_database_id` output after the first apply                                     |

`wrangler.jsonc` names relays `relay-1.…`; when the relay domain is decided, its `RELAYS` list takes the `relay_hostnames` output instead.

## Bootstrap (once per environment)

1. Create the environment's Cloudflare account and harden it (below). An environment with `relay_dns_mode = "load_balancer"` (production) needs the Load Balancing add-on before its first apply (Relay DNS below has the price note); staging starts with `"records"` and needs none. Production needs `ptbk.io` in its account; staging needs its own zone (`<staging-zone>`), because a zone lives in one account and the staging token must never reach production.
2. Create the R2 bucket `ptbk-tofu-state-<env>` in that account and an R2 API token with Object Read & Write on that bucket only.
3. Generate the state passphrase (at least 32 random characters) and store it in the team password manager. Losing it means rebuilding state by import.
4. Create the IaC and deploy tokens (below).
5. Replace the placeholders, then plan and apply (below).
6. At the registrar: set the engine domain's name servers to `engine_name_servers` and add the `dnssec_ds` record. DNSSEC is in effect only once the DS record is published; record the result under DNSSEC status.
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

Account-owned tokens (not tied to a member), one set per environment, created by hand: managing tokens from code would need a token that can mint any token. Cloudflare cannot scope Workers or D1 permissions to one script or database, so "the dashboard only" holds because each environment's account contains nothing else.

| Token                      | Used by                                          | Permissions                                                                                                                                                                                                                                                                                                                                           | Never                                                               |
| -------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ptbk-<env>-iac`           | Humans running this stack; password manager only | Account: D1 Edit, and the Email Service sending permission (confirm its exact name when the account exists). Account: Load Balancing: Monitors and Pools Edit, Notifications Edit. Zone (all zones in the account): Zone Edit (to create the engine zone), DNS Edit (records, DNSSEC), SSL and Certificates Edit (Universal SSL), Load Balancers Edit | Workers, API tokens, members, billing. Never in CI, never on a host |
| `ptbk-<env>-deploy`        | `wrangler deploy` and D1 migrations in CI (I-03) | Account: Workers Scripts Edit (includes Durable Objects), D1 Edit, Account Settings Read. Zone (dashboard zone only): Workers Routes Edit, for the custom domain in `wrangler.jsonc`                                                                                                                                                                  | Any DNS, zone or SSL permission; the engine zone                    |
| R2 `ptbk-tofu-state-<env>` | Humans running this stack                        | Object Read & Write on that bucket                                                                                                                                                                                                                                                                                                                    | Any other bucket                                                    |

Relays hold no credential for the engine zone or the dashboard zone. Their only Cloudflare credential is a token with Zone Read and DNS Edit on the ACME challenge zone, a zone that serves nothing else, for their own certificates (I-01, [ADR 0011](../../docs/adr/0011-infrastructure-as-code.md)). The dashboard Worker reaches D1 and email through bindings, not tokens. A DNS credential for the engine domain on a relay would let a compromised relay obtain certificates for engine hostnames.

Workers Routes Edit lets the deploy token attach the dashboard Worker to hostnames in the dashboard zone, which can affect availability but not DNS records or certificates. If the first deploy shows wrangler needs more for the custom domain, record the exact permission here and rerun the check.

Verify every new or rolled deploy token, and paste the output into the PR or the rotation note:

```sh
CLOUDFLARE_API_TOKEN=<deploy token> CLOUDFLARE_ACCOUNT_ID=<account> scripts/verify-deploy-token.sh <engine zone id> <dashboard zone id>
```

It must report Workers and D1 reachable and DNS read and write refused in both zones. Rotate tokens at least yearly and at once when someone with access leaves; the procedure for a leaked token is in I-03's deploy runbook.

## Account hardening

- **Members:** as few as possible. Two named maintainers are Super Administrators; anyone else gets a scoped role. Remove members the day they leave.
- **Two-factor:** turn on "Enforce two-factor authentication" for the account. Every member registers at least two hardware security keys and no authenticator app or SMS. Cloudflare cannot enforce the factor type, so the monthly review confirms it with each member.
- **Registrar** (engine domain and `ptbk.io`): transfer lock on, hardware-key 2FA on the registrar account, DS record published.
- **Audit log review**, monthly and after every incident, in each account (Manage Account, Audit Log), by a maintainer who records the date and findings in the team's ops log:
  - API tokens created, rolled or re-scoped; members added or roles changed;
  - DNS or zone setting changes that match no merged PR (Universal SSL, proxy status, DNSSEC);
  - then `tofu plan` in each environment must show no changes; any drift is investigated before it is overwritten.

## Relay DNS (I-07)

With `relay_dns_mode = "load_balancer"` (production's setting), `*.<engine domain>` is a DNS-only Cloudflare load balancer (`modules/environment/relay-dns.tf`), so a relay that stops completing TLS handshakes leaves DNS by itself. Browsers fail over on their own from a relay that refuses connections or does not answer at all, but not from one that accepts TCP and then hangs: they wait for its TLS answer and never try the next address (measured in `e2e/tests/network/relay-failover.spec.ts`). Nothing at runtime holds a token for the engine zone.

- **Modes.** `"records"` (staging's setting while it has one relay) publishes plain wildcard A and AAAA records for every relay in rotation, with the same 30 s TTL and no add-on: browsers still fail over from a dead relay, but a hung one stays listed until it is taken out of rotation by hand (runbook below). With one relay the load balancer could drop nothing anyway, since the fallback pool always lists it; the rules refuse `"load_balancer"` with fewer than two relays.
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

| Environment | Zone signed | DS at registrar | Validated (`delv`) |
| ----------- | ----------- | --------------- | ------------------ |
| staging     | not applied | no              | no                 |
| production  | not applied | no              | no                 |

## Not here

Relay hosts (I-01), deploy workflows (I-03), uptime checks and the dashboard's alerts (I-04), the PSL submission itself and the CT watch (I-05, [abuse-takedown.md](../../docs/runbooks/abuse-takedown.md#public-suffix-list)). A second DNS provider and per-engine records (with per-engine CAA `accounturi` pinning, RFC 8657) come in v1 or later.
