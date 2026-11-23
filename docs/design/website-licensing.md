# Website licensing and account handoff

Refs: D-30. Owner decisions: 13 November 2026. Website implementation: `webgptorg/ptbk-landing-page-aldaron`, engine: `reborn/2026-10`.

## License API

`GET https://www.ptbk.io/api/promptbook-billing/app/licenses?subject=<UUID>`; `Authorization: Bearer <PROMPTBOOK_APP_LICENSE_SECRET>`, server only, no cookies, no CORS. 401 is authentication failure, 404 an unknown subject, 503 temporary failure. Request timeout 5 seconds. Poll after `refreshAfterSeconds` (initially 900). Persist the last known validated snapshot scoped to the linked organization and subject.

```json
{
  "version": 1,
  "subject": "4408b4d6-6005-4b77-97eb-fdd67847ee92",
  "generatedAt": "2026-11-13T00:00:00.000Z",
  "refreshAfterSeconds": 900,
  "enforcement": "advisory",
  "manageUrl": "https://www.ptbk.io/cs/pricing/predplatne",
  "grants": [
    {
      "id": "4408b4d6-6005-4b77-97eb-fdd67847ee93",
      "validFrom": "2026-11-13T00:00:00.000Z",
      "validUntil": null,
      "capabilities": {
        "engineProjects": 1,
        "specialists": 10,
        "controllingUsers": 5,
        "harnessInstances": null,
        "browserProfiles": 5,
        "remoteControl": true
      }
    }
  ]
}
```

Null means unlimited, zero means no contractual capacity. One grant may cover its configured number of simultaneously used projects, each within the listed capacities. Keep grants separate; summing three small grants must not invent one larger per-project grant. `licenseCoverage` computes a rearrangeable matching and notices, never a block. Unknown telemetry is not zero. No prices, coupons, referral codes, community seats, private content or permanent engine assignments cross this API.

Validation in the App: `manageUrl` is any https URL on `WEBSITE_ORIGIN` (any locale or page, no credentials in it), so the website can change it without breaking every read. Timestamps may carry an offset and microseconds, as Postgres writes them. A stored snapshot is validated again when read, so a changed origin never shows an old manage link.

## Configuration

| Name                            | Kind          | Meaning                                                                                                                                                                                                                                         |
| ------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADAPTERS.billing = "website"`  | var           | Mounts no Stripe Checkout, portal or webhook route and makes entitlements advisory; mounts the routes below.                                                                                                                                    |
| `WEBSITE_ORIGIN`                | var, optional | The website, an https origin. Defaults to `https://www.ptbk.io`; staging may point elsewhere.                                                                                                                                                   |
| `WEBSITE_HANDOFF_URL`           | var           | Required with `website`. The website page that starts the handoff, on `WEBSITE_ORIGIN`; the App adds `?challenge=`. No default: on 16 November 2026 the website had no such page yet (see open points).                                         |
| `PROMPTBOOK_APP_LICENSE_SECRET` | Worker secret | Required with `website`, refused if missing or shorter than 32 characters. The same value as the website's variable of that name; server to server only, never in the SPA, a var, a log or the repo. Not the Stripe, session or engine secrets. |
| `LICENSE_ENFORCEMENT`           | var, optional | `advisory` (default, and every environment) or `enforce`, with `website` only. See [Enforcement](#enforcement).                                                                                                                                 |

## Website-first handoff

Decided by Seb on 16 November 2026 (ADR 0021, update): **the website proves a mailbox, the App confirms it itself.** The website is never an identity authority for creating, signing into or recovering an App account, nor for engine access or step-up.

1. **Start.** `GET /api/website-access/start` creates 32 random bytes as base64url, stores only their SHA-256 for 10 minutes (`website_handoff_states`), sets them in the `__Host-ptbk_website_state` cookie (HttpOnly, Secure, SameSite=Lax, 10 minutes) and answers 303 to `WEBSITE_HANDOFF_URL?challenge=<challenge>`. The website's "Open app" link should point here, so the cookie exists on the App's origin before any identity comes back.
2. **Website.** Its page, with the member's session, calls its same-origin `POST /api/promptbook-billing/handoff` with `{ "challenge": "…" }`, which stores the hash of a 60-second ticket and returns `https://app.ptbk.io/api/website-access/return?code=<ticket>`; the page sends the browser there.
3. **Return.** `GET /api/website-access/return?code=` (43 base64url characters, else 400) reads the state cookie, consumes its stored hash in one statement (missing cookie, unknown, used or expired state: no call to the website), then exchanges server to server (`POST /api/promptbook-billing/app/exchange`, bearer, `{ code, challenge }`, 5-second timeout, bounded response, strict `emailVerified: true`). Forged, replayed, expired or foreign tickets come back 403 from the website and fail closed too. Every outcome clears the state cookie and answers 303 with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, so the ticket leaves the address bar at once: to `/website-access` on success, or `/website-access?error=expired|failed`. A return without a ticket (the member cancelled on the website) or with the website's `?error=<slug>` (1–64 of `A-Za-z0-9_.-`) spends the state the same way and lands on `?error=failed`; any other query shape, such as a ticket and an error together, is a 400.
4. **Pending link.** On success the verified subject and address wait 30 minutes in `website_pending_links` behind a new random cookie, `__Host-ptbk_website_link` (HttpOnly, Secure, SameSite=Strict; only its SHA-256 is stored). The App issues no session and links nothing yet.
5. **`/website-access`** asks `GET /api/website-access/pending` (this browser's address and whether an App account has it), then:
   - **Signed in, same address, owner or admin of the active organization:** `POST /api/website-access/link` links that organization at once.
   - **Signed in with another address:** the page explains and offers to sign out; the server refuses with 409 `email-mismatch` and keeps the pending link, so signing in with the right passkey can still finish it.
   - **Signed in as a member:** the page explains; the server answers 403 (`license.link` is owners and admins only).
   - **Signed out, an account has the address:** sign in with its passkey (`/signin?returnTo=/website-access`), then link.
   - **Signed out, no account:** sign-up with the address shown read-only. The App sends its **own** one-click confirmation link (the normal `signup/start` flow, its rate limits and its "account exists" email), then the normal passkey ceremony creates the account; back on `/website-access` (a storage hint brings the emailed link's tab there too), it links.
6. **Link.** `POST /api/website-access/link` (session, `license.link`, a sensitive action, so not during the recovery cooldown) compares the session's address with the pending one, then binds subject and organization in one D1 batch with its `org_audit_log` entry (`website.link`, target the subject). One subject has one organization and the other way round: an identical binding is kept, anything else is 409 `website-link-conflict`. Nothing is merged and nothing is re-attached; changing a link is a later, explicit flow.

Logs carry the outcome kind and the organization ID only, never the ticket, challenge, cookie, secret or address.

## Routes

| Route                             | Auth    | Permission     | Rate limit                   | Answers                                                                                    |
| --------------------------------- | ------- | -------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/website-access/start`   | public  | –              | `website-access-ip`, 60/h/IP | 303 to `WEBSITE_HANDOFF_URL`, sets the state cookie                                        |
| `GET /api/website-access/return`  | public  | –              | `website-access-ip`          | 303 to `/website-access` (`?error=expired`/`failed`, also on cancel), sets the link cookie |
| `GET /api/website-access/pending` | public  | –              | `website-access-ip`          | `{ email, accountExists, expiresAt }` for this browser's cookie, else 404                  |
| `POST /api/website-access/link`   | session | `license.link` | –                            | `{ linked: true }`; 404 `pending-invalid`, 409 `email-mismatch` / `website-link-conflict`  |
| `GET /api/license`                | session | `license.read` | –                            | The linked account, snapshot state, grants, coverage and an advisory notice                |

All five are mounted only with `ADAPTERS.billing = "website"`. `license.read` and `license.link` are owners and admins.

## In the App

- **Reads.** `GET /api/license` reads through the licence reader (`domain/licensing/license-reader.ts`) when License, Engines, New engine or the invitation dialog loads: the stored licence until `refreshAfterSeconds`, then the website with a 5-second timeout; on any failure the last one shows as stale, or nothing as unknown. `website_license_snapshots` keeps one per organization (subject, the licence as JSON, fetched-at), validated again on every read.
- **Coverage.** Engines are the organization's active engines (`engineProjects`), people its members (each engine's `controllingUsers` at most that many). Specialists, harness instances and browser profiles stay unknown, never zero, until engines report them. The notice is `unlinked`, `missing`, `expired` (no active grant, one ended) or `exceeded` (an engine not covered); it never blocks anything.
- **Status.** The grants decide, as of now, so a stale snapshot never shows an ended grant as active: `active` (and when it ends: the last active grant's end, none if any is open-ended), `scheduled` (when the first future grant starts), `expired` (when the last one ended) or `none`. The website's own status adds only what grants cannot say: that an active grant is a `trial`, or, as its lookup sends no past or future grants, that a licence has ended or not started. The plan name is the website's `display.label`, shown as text; without one, "ptbk.io license" or "N licenses".
- **Screens.** With `website`, Billing becomes License (`/billing` redirects there). Its first section is the status: plan name, a state pill (Active, Trial, Starts later, Expired, Not checked; none without a licence), the term ("Valid until …", "Trial ends …", "Ended …", "Starts …"), projects and people against the licence (the screens call engines projects), and "Manage on ptbk.io" (`manageUrl`), or "Buy on ptbk.io" and "Link your ptbk.io account" without one. Then the linked account with "Last checked …", and each grant. The projects list (`/engines`) shows the notice to owners and admins. All of it is quiet: no alarm tone, and nothing waits on it.

## Enforcement

Decided by Seb on 20 November 2026: the licence is shown, not enforced, but the App is ready to enforce it later at exactly two **check points**, and only for what is new.

| Check point     | Asked when                                                                          | Projects                    | Denied as                                                                                        |
| --------------- | ----------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| `engine.link`   | the New engine page checks eligibility, and a link code is issued (also for a team) | one more engine             | `engine-limit` (over the licence) or `not-entitled` (no licence, none linked), the existing 403s |
| `member.invite` | invitations are sent (`POST /api/invites`)                                          | one more person per address | 403 `license-limit`                                                                              |

A running engine, its control, a link code already issued (its engine still registers) and everyone's existing access are never checked, so a licence can never cut them off.

`checkLicense` (`domain/licensing/license-checks.ts`) answers `ok`, `warn` or `deny` with a reason (`unlinked`, `missing`, `expired`, `over-limit`), from the same summary License shows with the action's engine or people added. One switch, `LICENSE_ENFORCEMENT`, decides what a shortfall means:

- **`advisory`** (the default, and every environment today): a shortfall is `warn`. The routes don't even read the licence (`LicenseGate` answers `ok` at once), so a slow website never slows linking or inviting. `GET /api/license` returns both check points (`checks.engineLink`, `checks.memberInvite`), and New engine and the invitation dialog show one calm line when one would warn.
- **`enforce`**: a shortfall is `deny` only when the website answered just now, or no account is linked. A stale snapshot only warns and a website that hasn't answered passes, so an outage never stops anyone. It needs billing `website`; config refuses it otherwise, and a test fails if any committed environment sets it.

Turning it on is a product decision and a var; its behaviour is tested (`license-checks.test.ts`, `license-service.test.ts`, and "licence check points" in `test/http/website-licensing.test.ts`).

## Where the website plugs in

Everything the App asks the website goes through two ports, each with one HTTP adapter, so a change on the website's side is a change in one adapter:

| Port                                                                          | Adapter                                        | Today                                                                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `WebsiteLicenseApi.lookup({ subject })` (`license-contract.ts`)               | `adapters/licensing/website-license-api.ts`    | `GET /api/promptbook-billing/app/licenses?subject=`: the bare snapshot, so status and plan name are null |
| `WebsiteIdentityExchange.exchange({ code, challenge })` (`website-access.ts`) | `adapters/licensing/website-handoff-client.ts` | `POST /api/promptbook-billing/app/exchange`                                                              |

The adapters are built in `create-dashboard.ts` and handed to the routes as `deps.licensing`. Tests use them against a fake website (`testing/fake-website.ts`, over `fetch`) in the HTTP tests, and a deterministic fake of the licence port (`testing/fake-website-license-api.ts`, shaped after the website's lookup fixtures) in the domain tests.

When Pavol's endpoint for linking organizations lands (expected 20 November 2026):

- **A licence lookup that sends status and plan name** (as the website's `POST /api/promptbook-billing/app/licenses` lookup does, with `status`, `display.label` and a nested `snapshot`): parse it in `website-license-api.ts` into `{ snapshot, status, label }`. Nothing else changes; License then shows the plan name and Trial.
- **Another way to address the account** (an email or an organization reference instead of the subject): extend `WebsiteAccountRef` and what `website_links` stores for it. The reader, checks and screens don't look inside it.
- **A changed handoff**: `website-handoff-client.ts` for the exchange; the routes and cookies stay unless the flow itself changes, which would need the separate security review again.

## Deployment checklist

- [x] Website trial/license/grant endpoints and challenge exchange prepared.
- [x] App numeric parsers, polling client, advisory matching, website billing selection and identity-linking guard prepared.
- [x] Organization-scoped link and snapshot persistence, typed handoff routes with the App's own email confirmation and passkey enrollment (PR #290; its auth part needs a separate review).
- [x] Coverage notices on the License and Engines screens, with the manage link.
- [x] The licence status on License, and the `engine.link` and `member.invite` check points, advisory (`LICENSE_ENFORCEMENT` unset everywhere).
- [ ] Pavol's endpoint for linking organizations, behind the ports above.
- [ ] Follow-up (#327): a quiet licence line in the engine UI, linking to the dashboard or the website.
- [ ] The website's handoff page and "Open app" link (open point below), then `WEBSITE_HANDOFF_URL`.
- [ ] Install the dedicated shared server credential in both deployments, then select website billing ([apply.md](../plan/apply.md), step 13). Do not reuse Stripe/session/engine secrets.
- [ ] Test one-time handoff, forged/replayed/expired tickets, account mismatch, multiple Start/Business grants, unknown telemetry, outage and expired trial with actual staging control.

These unchecked apply/integration items are not a claim that remote controls are usable. Relay connectivity currently proves connectivity only; Sebastián must confirm the remaining controls and delivery schedule before public promotion.

## Open points on the website side (16 November 2026)

- No page reads `?challenge=` and calls `POST /api/promptbook-billing/handoff` yet, and there is no "Open app" link; `WEBSITE_HANDOFF_URL` waits for that page.
- The callback is hard-coded to `https://app.ptbk.io`. That is both staging's and production's App origin today; a separate staging App would need it configurable.
- Test accounts (`is_test`) cannot hand off or read licences, so a website with test-mode Stripe cannot exercise the flow end to end.
