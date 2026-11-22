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

## Website-first handoff

1. App creates 32 random bytes as base64url, retains them in a short-lived HttpOnly Secure SameSite=Lax `__Host-` login-state cookie, and redirects to the website member area with that challenge. Initiate from the website's App link as well, so the state cookie is established at the destination before identity transfer.
2. Website uses its verified member session. Its POST `/api/promptbook-billing/handoff` accepts `{ "challenge": "<43 base64url characters>" }`, stores only a hash of a 60-second ticket, and returns the fixed App callback `/api/website-access/return?code=<ticket>`.
3. App callback requires the browser's unexpired state cookie. Exchange server-to-server via POST `/api/promptbook-billing/app/exchange` with the dedicated bearer and `{ "code": "…", "challenge": "…" }`. Missing cookie, replay, expiry, wrong challenge or unverified identity fails closed. Clear state and scrub the ticket URL with an immediate redirect and no-referrer/no-store headers.
4. Response is `{ "version":1, "subject":"<UUID>", "email":"verified address", "emailVerified":true }`. Link atomically to the authenticated matching App account through `linkWebsiteIdentity`. Do not attach a new subject to a different account, auto-merge unrelated organizations, grant a fresh step-up, or bypass engine-origin passkeys. New-account enrollment should reuse the normal passkey ceremony after the verified website proof, without a second email form. Until that ceremony is integrated, keep the App launch button disabled publicly.

## Deployment checklist

- [x] Website trial/license/grant endpoints and challenge exchange prepared.
- [x] App numeric parsers, polling client, advisory matching, website billing selection and identity-linking guard prepared.
- [ ] Integrate organization-scoped identity/cache persistence and typed App handoff routes with existing passkey enrollment. This requires the App owner's auth review; no route is exposed by this PR before it is wired.
- [ ] Wire current coverage notices to engine/account screens, with one member-area backlink. Keep existing registration abuse limits.
- [ ] Install the dedicated shared server credential in both deployments, then select website billing. Do not reuse Stripe/session/engine secrets.
- [ ] Test one-time handoff, forged/replayed/expired tickets, account mismatch, multiple Start/Business grants, unknown telemetry, outage and expired trial with actual staging control.

These unchecked apply/integration items are not a claim that remote controls are usable. Relay connectivity currently proves connectivity only; Sebastián must confirm the remaining controls and delivery schedule before public promotion.
