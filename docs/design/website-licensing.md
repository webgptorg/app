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

## Website-first handoff

Decided by Seb on 16 November 2026 (ADR 0021, update): **the website proves a mailbox, the App confirms it itself.** The website is never an identity authority for creating, signing into or recovering an App account, nor for engine access or step-up.

1. **Start.** `GET /api/website-access/start` creates 32 random bytes as base64url, stores only their SHA-256 for 10 minutes (`website_handoff_states`), sets them in the `__Host-ptbk_website_state` cookie (HttpOnly, Secure, SameSite=Lax, 10 minutes) and answers 303 to `WEBSITE_HANDOFF_URL?challenge=<challenge>`. The website's "Open app" link should point here, so the cookie exists on the App's origin before any identity comes back.
2. **Website.** Its page, with the member's session, calls its same-origin `POST /api/promptbook-billing/handoff` with `{ "challenge": "…" }`, which stores the hash of a 60-second ticket and returns `https://app.ptbk.io/api/website-access/return?code=<ticket>`; the page sends the browser there.
3. **Return.** `GET /api/website-access/return?code=` (43 base64url characters, else 400) reads the state cookie, consumes its stored hash in one statement (missing cookie, unknown, used or expired state: no call to the website), then exchanges server to server (`POST /api/promptbook-billing/app/exchange`, bearer, `{ code, challenge }`, 5-second timeout, bounded response, strict `emailVerified: true`). Forged, replayed, expired or foreign tickets come back 403 from the website and fail closed too. Every outcome clears the state cookie and answers 303 with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, so the ticket leaves the address bar at once: to `/website-access` on success, or `/website-access?error=expired|failed`.
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

| Route                             | Auth    | Permission     | Rate limit                   | Answers                                                                                   |
| --------------------------------- | ------- | -------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/website-access/start`   | public  | –              | `website-access-ip`, 60/h/IP | 303 to `WEBSITE_HANDOFF_URL`, sets the state cookie                                       |
| `GET /api/website-access/return`  | public  | –              | `website-access-ip`          | 303 to `/website-access` (`?error=expired`/`failed`), sets the link cookie                |
| `GET /api/website-access/pending` | public  | –              | `website-access-ip`          | `{ email, accountExists, expiresAt }` for this browser's cookie, else 404                 |
| `POST /api/website-access/link`   | session | `license.link` | –                            | `{ linked: true }`; 404 `pending-invalid`, 409 `email-mismatch` / `website-link-conflict` |
| `GET /api/license`                | session | `license.read` | –                            | The linked account, snapshot state, grants, coverage and an advisory notice               |

All five are mounted only with `ADAPTERS.billing = "website"`. `license.read` and `license.link` are owners and admins.

## In the App

- **Reads.** `GET /api/license` reads through the polling client when License or Engines loads: the cached snapshot until `refreshAfterSeconds`, then the website with a 5-second timeout; on any failure the last snapshot shows as stale, or nothing as unknown. `website_license_snapshots` keeps one per organization (subject, JSON, fetched-at).
- **Coverage.** Engines are the organization's active engines (`engineProjects`), people its members (each engine's `controllingUsers` at most that many). Specialists, harness instances and browser profiles stay unknown, never zero, until engines report them. The notice is `unlinked`, `missing`, `expired` (no active grant, one ended) or `exceeded` (an engine not covered); it never blocks anything.
- **Screens.** With `website`, Billing becomes License (`/billing` redirects there): the linked account or "Link your ptbk.io account", "Last checked …", coverage, each grant (validity, capacities, null as unlimited) and "Manage on ptbk.io" to `manageUrl`. The Engines screen shows the notice to owners and admins.

## Deployment checklist

- [x] Website trial/license/grant endpoints and challenge exchange prepared.
- [x] App numeric parsers, polling client, advisory matching, website billing selection and identity-linking guard prepared.
- [x] Organization-scoped link and snapshot persistence, typed handoff routes with the App's own email confirmation and passkey enrollment (PR #290; its auth part needs a separate review).
- [x] Coverage notices on the License and Engines screens, with the manage link.
- [ ] The website's handoff page and "Open app" link (open point below), then `WEBSITE_HANDOFF_URL`.
- [ ] Install the dedicated shared server credential in both deployments, then select website billing ([apply.md](../plan/apply.md), step 13). Do not reuse Stripe/session/engine secrets.
- [ ] Test one-time handoff, forged/replayed/expired tickets, account mismatch, multiple Start/Business grants, unknown telemetry, outage and expired trial with actual staging control.

These unchecked apply/integration items are not a claim that remote controls are usable. Relay connectivity currently proves connectivity only; Sebastián must confirm the remaining controls and delivery schedule before public promotion.

## Open points on the website side (16 November 2026)

- No page reads `?challenge=` and calls `POST /api/promptbook-billing/handoff` yet, and there is no "Open app" link; `WEBSITE_HANDOFF_URL` waits for that page.
- The callback is hard-coded to `https://app.ptbk.io`. That is both staging's and production's App origin today; a separate staging App would need it configurable.
- Test accounts (`is_test`) cannot hand off or read licences, so a website with test-mode Stripe cannot exercise the flow end to end.
