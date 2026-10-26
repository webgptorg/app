# Abuse takedown

What to do when an engine on our engine domain serves phishing, malware or anything else that harms people (task I-05; spec, Abuse on our domains). The target for a confirmed report is takedown within hours, and the public `/abuse` page promises it.

Read this first: we cannot see what an engine serves to signed-in users or what its traffic contains, by design. Everything below works from what any anonymous visitor sees, the engine's registry data and the aggregates in [observability.md](observability.md). Nothing here asks an owner, a relay or a log for engine content, and nothing should.

## Who acts

| Role                    | Who                                                       | Does                                                                                                   |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Abuse handler           | The maintainer watching `abuse@` (`ABUSE_EMAIL`) that day | Acknowledges reports, triages, collects evidence, opens the case, writes to the owner and the reporter |
| Platform admin          | A maintainer with `platform_role = 'admin'` and a passkey | Suspends the engine. May be the abuse handler                                                          |
| Second maintainer       | Another platform admin, never the one who suspended       | Decides appeals and unsuspends                                                                         |
| Seb (legal and company) | Seb, with counsel                                         | Legal requests, legal holds, anything that would disclose account data to a third party                |

`abuse@` receives reports through `/abuse` and `security.txt`, and every `[ptbk abuse]` alert: `ct-wildcard`, `ct-foreign-issuer`, `ct-unknown-hostname`, `ct-issuance-spike`, `public-face-mismatch` and abuse-feed listings ([apps/dashboard/README.md](../../apps/dashboard/README.md#abuse-controls-i-05)). Search Console and Safe Browsing notices for the engine domain arrive there too (Monitoring setup below). An alert is a lead, never a verdict: no job suspends anything by itself.

## 1. Triage

1. **Acknowledge** the report the same day, from `abuse@` (what to write is in step 4). Open a case in the abuse log (see Records) with an ID such as `abuse-2026-0007`; it is the reference everywhere else.
2. **Find the engine.** A default hostname is `<engine ID>.<engine domain>`: the first label is the engine ID. For a custom hostname, look it up in D1, from `apps/dashboard`:
   ```sh
   npx wrangler d1 execute DB --env production --remote \
     --command "SELECT engine_id, status FROM engine_hostnames WHERE hostname = '<hostname>'"
   ```
   A hostname that is neither ours nor a registered custom hostname is not ours to take down: tell the reporter who hosts it if that is evident, and close the case.
3. **Classify.** Phishing, malware, credential harvesting and child sexual abuse material are **urgent**: suspend as soon as the evidence is collected, then write to the owner. Everything else (copyright, defamation, spam, a page we cannot reproduce) is **standard**: write to the owner first and give them 48 hours, unless it escalates. When unsure, treat it as urgent; a suspension can be lifted, a blocked domain takes weeks.

## 2. Evidence (the public page only)

Collect what an anonymous visitor sees, from a disposable browser profile or VM with no session anywhere (not the browser holding your dashboard session), and never type credentials, run downloads or follow the page's own links beyond what proves the report:

- the full URL, the time (UTC) and a full-page screenshot;
- the response headers and status: `curl -sS -o /dev/null -D - https://<hostname>/<path>`;
- the certificate it serves: `openssl s_client -connect <hostname>:443 -servername <hostname> </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256`, and its crt.sh entry;
- third-party verdicts: Google's Safe Browsing site status page for the URL, and the abuse-feed or CT alert that raised it, if one did;
- what the reporter sent (the message, their screenshot).

A page that shows only the stock engine sign-in page is not evidence of abuse: what lies behind the sign-in is invisible to us, and asking the reporter for their credentials or a session is never acceptable. In that case, write to the owner with what the reporter describes and keep the case open.

## 3. Suspend

1. Sign in to the dashboard, open `/admin`, enter the engine ID and go to `/admin/engines/<engine ID>`.
2. **Suspend**, with the case ID as the reason (`abuse-2026-0007: phishing, see case`). The passkey step-up is asked for if you have not had one within 5 minutes. The reason goes only to `admin_audit_log`; keep personal data out of it.
3. The page then shows the engine as suspended by the platform. From that moment:
   - the registry answers `suspended` for it, with its default hostname only (custom hostnames withheld);
   - registration and heartbeats with its key answer 403 `engine-suspended`, so re-linking the same engine does not bring it back;
   - its owner sees "suspended by Promptbook" with the abuse address, never the reason.

**Relay cut-off timing.** Each relay looks every connected engine up again past its cache every `RELAY_REGISTRY_TTL_S` (300 s by default, [apps/relay/README.md](../../apps/relay/README.md#tunnel-endpoint)), closes a suspended one's tunnel with `SUSPENDED`, and refuses its new tunnels from then on. So every relay has dropped it within **5 minutes**, and its default and custom hostnames stop answering. Ten minutes after suspending, check from outside: `curl -sS -m 10 https://<hostname>/` must fail (no tunnel, so the relay has nowhere to route it), for the default hostname and every custom one. Record the time in the case.

If the dashboard is down, relays keep serving their last registry entry for up to `RELAY_REGISTRY_MAX_STALE_S` (24 hours): a suspension made before the outage holds, but one made during it cannot reach the relays until the dashboard is back. Restarting a relay then would drop every engine, since it would start with an empty cache. Get the dashboard back first ([observability.md](observability.md)).

**Rule out a repeat.** A suspended engine's owner can install a new engine with a new key, which gets a new hostname; the engine-creation limits (`engines.create`, `engines.max`, ADR 0017) slow that down but do not stop it. v0 has no organization-wide suspension. For a repeat offender, cancel the organization's subscription in Stripe: a canceled subscription's plan no longer applies to the organization's entitlements. Note it in the case.

**What we cannot do.** Suspension takes an engine off our network; it does not reach the owner's server:

- we cannot see or delete anything on the engine, or tell what it showed signed-in users;
- the engine keeps running, and keeps its own certificate (its key and ACME account are the owner's); without our relays the hostname routes nowhere, so the certificate serves nothing;
- a custom hostname's owner can point its DNS straight at the server, and an engine in direct mode on its own domain never used our relays: for those, the domain's owner, registrar or host is who can act.

## 4. Tell the owner and the reporter

Write from `abuse@`, in the owner's language (`users.locale`, English or Czech). The owners of the engine's organization:

```sh
npx wrangler d1 execute DB --env production --remote --command "SELECT u.email, u.locale FROM engines e \
  JOIN memberships m ON m.org_id = e.org_id AND m.role = 'owner' JOIN users u ON u.id = m.user_id \
  WHERE e.engine_id = '<engine ID>'"
```

- **Owner, on suspension** (or before it, for a standard case): the hostname, what was reported and when, what we saw on the public page (the screenshot), that the engine is suspended and what that means (our relays no longer route it; nothing on their server was touched or read), and how to appeal: reply to this message with what was wrong and what they changed. Never name the reporter or forward their message.
- **Reporter, on receipt:** we have the report and will look at it; never send us passwords you typed into the page.
- **Reporter, on closing:** whether we acted (the engine is no longer reachable through our network) or why not. Nothing about the owner, their account or their organization.
- **Custom hostname:** also tell the domain's owner or its registrar. Suspension stops our relays from routing it, but they control the DNS and could point it straight at the server.

## 5. After the takedown

- If Search Console reports a security issue for the engine domain, or Safe Browsing lists the hostname, request a review once the hostname no longer answers.
- Watch the engine domain's own reputation (Monitoring setup below) for a week after a takedown.

## 6. Appeal and unsuspend

The owner appeals by replying. The **second maintainer** reads the case and the appeal and decides; a lift needs a credible explanation and a page that no longer does what was reported. A suspended engine cannot be checked through our network, so the owner shows the fixed state another way (a screenshot, or the page served on a host of theirs we can open).

To lift it: `/admin/engines/<engine ID>`, **Unsuspend**, reason `abuse-2026-0007: appeal accepted, see case`. The engine routes again once it reconnects to the relays and their next lookup sees it active (within one TTL). Unsuspend lifts only a platform suspension: an engine its owner revoked answers 409 `owner-revoked` and stays revoked. Write to the owner either way, and close the case.

## 7. Legal requests and legal hold

Requests from law enforcement or courts go to Seb, who decides with counsel; nobody else answers them or hands out data. We can disclose only what we hold: account and billing data, the engine's registry data, the engine's IP from the relay journals and our case record. We cannot disclose content, because we never have it, and we say so.

A **legal hold** freezes what would otherwise expire. Act on the day it arrives, because the short retention periods are the point:

- relay journals keep engine IPs and tunnel times for **7 days**: on every relay, `sudo journalctl -u ptbk-relay -o json --since '<date>' | grep '"<engine ID>"' > <case ID>-<relay>.jsonl`, copied off the host into the case;
- Workers Logs keep the dashboard's logs (engine IDs and outcomes, no IPs) for at most **7 days**;
- D1 rows (engine, organization, owners, `admin_audit_log`) stay unless deleted: note in the case that they are held, and delete nothing of that organization until the hold is lifted.

## Records kept

| Record                                                     | Where                                                                                                 | Kept for                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Case: report, evidence, decisions, messages sent, timings  | The abuse log (the `abuse@` mailbox, one thread per case ID) and the team drive folder of the same ID | 2 years after the case closes, then deleted, unless under a legal hold |
| Suspend and unsuspend, with admin, time and case reference | `admin_audit_log` in D1 (insert only)                                                                 | For the life of the platform                                           |
| Exports made for a legal hold                              | The case folder                                                                                       | Until the hold is lifted, then deleted                                 |
| Engine IPs, tunnel times                                   | Relay journals                                                                                        | 7 days (observability.md); longer only as a legal-hold export          |

The 2-year case retention is our working rule until the privacy policy (legal, out of I-05's scope) sets the period; change this table when it does.

## Monitoring setup (manual, at Apply)

Done once per engine domain, with I-05's Apply ([apply.md](../plan/apply.md)):

- **Search Console:** add the engine domain as a domain property, verified by its TXT record through `extra_records` in `infra/cloudflare`; add `abuse@` as a user with email notifications on. Security issues (Safe Browsing's verdicts for the domain) then reach the abuse inbox.
- **Abuse feed:** Google Web Risk (decided 2026-10-26, plan, Decisions). Its API key goes into the dashboard as a Worker secret and backs the `abuse-feeds` job's `AbuseFeed` port.
- **CT watch:** runs without credentials; the optional `CERTSPOTTER_API_KEY` secret lifts Cert Spotter's hourly allowance.

## Public Suffix List

The engine domain goes on the Public Suffix List (private section), so browsers and reputation systems treat each engine as its own site and Let's Encrypt's per-domain rate limits stop counting all engines together (spec, Abuse on our domains, item 2). It does not block launch.

1. Once the engine domain is applied (`infra/cloudflare`) and has at least two years of registration left, open the pull request to [publicsuffix/list](https://github.com/publicsuffix/list) following its guidelines: one entry, the engine domain itself, in the private section under our organization.
2. Set `psl_pull_request` to that pull request's URL in `infra/cloudflare/environments/production/terraform.tfvars`, plan (one new TXT record, `_psl.<engine domain>`) and apply. Check with `dig +short TXT _psl.<engine domain>`. Keep the record for as long as the entry exists: the maintainers check it on every later change.
3. Record the pull request here and file Let's Encrypt's rate-limit adjustment request for the engine domain (linked from its rate limits documentation); record that too.

| Item                                | Status                                    |
| ----------------------------------- | ----------------------------------------- |
| PSL pull request                    | not opened (engine domain not chosen yet) |
| Let's Encrypt rate-limit adjustment | not filed (engine domain not chosen yet)  |
