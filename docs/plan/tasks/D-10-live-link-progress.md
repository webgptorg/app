# D-10. Link flow: trial with a card, live link progress and the ready state

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-03, D-05, D-06, D-07, M-08
- **Status:** in progress (feat/d-10-live-link-progress)
- **Spec:** Pairing and identity (First setup); Abuse on our domains (item 4); What our platform can and cannot do; ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0007](../../adr/0007-frontend-stack.md), [0017](../../adr/0017-billing-entitlements.md); design: [onboarding.md](../../design/onboarding.md) (Journey 1, steps 2 to 4)

## Goal

`/engines/new` takes a new person from "no plan" to "engine ready" without leaving the page: a trial with a card on file comes first, then the install command, then a live checklist that follows the engine from linked to online to owner set up, ending in "Open engine".

## Context

Today a new account has no plan and learns that only from an error after clicking "Create link code"; Checkout returns to `/billing`; the link page has no live view, so the person must find `/engines` on their own; and the intro hard-codes "30 minutes". Decided 2026-10-26 (E-05): a trial with a card on file before the install command (billing gate, option B), and no engine contract change: progress comes from the registration, the heartbeat and, once R-07 lands, relay tunnel presence.

D-07's entitlements already treat a `trialing` subscription as granting its plan (`PLAN_STATUSES` in `domain/billing/billing-state.ts`), so a trial needs no new entitlement logic: it is a Checkout setting plus once-per-organization bookkeeping.

## Scope

- **Trial with card** (D-07 code, configuration only where possible):
  - `BILLING_PLANS` plans gain an optional `trialDays` (integer 1 to 30, validated in `plan-catalogue.ts`).
  - `createCheckoutSession` passes `subscription_data.trial_period_days` and `payment_method_collection: 'always'` when the plan has `trialDays` and the organization never had a trial. The organization records `trialStartedAt` (new nullable column through drizzle-kit), set from the `customer.subscription.*` webhook when the status is `trialing`.
  - The fake provider simulates `trialing`. The billing page shows "Trial until {date}" (built) and the plan card shows "Start your {n}-day trial" when one is available.
- **Plan step first:** `/engines/new` asks for entitlements on load (a new `GET /api/engines/link-eligibility` answering `allowed | not-entitled | engine-limit`, through `EngineCreationPolicy`). Without `engines.create` it shows the plans inline, "Choose a plan to link your engine", and Checkout returns to `/engines/new?checkout=success` (an allowlisted return path, not a free URL). At the limit, the existing banner.
- **Code on load:** once eligible, the page creates the link code without an extra click. The API returns `{ linkCodeId, linkCode, installCommands, installGuideUrl, expiresAt }` (D-11 made `installCommands` a list); `linkCodeId` is random and stored next to the hash. The page URL becomes `/engines/new?link=<linkCodeId>`. After a reload the command is not shown again, but the progress is.
- **Status endpoint:** `GET /api/engines/link-codes/:linkCodeId`, org-scoped (`engine.link`), answering `pending | expired | linked { engineId, hostname }`. For a linked engine, the page reads `GET /api/engines/:engineId` (built) for status, version and `members`.
- **Live checklist** with the states, copy and timings of onboarding.md step 4: waiting, linked (engine ID, address, large fingerprint with the compare line), online, reachable (only when the engine status carries relay presence, R-07), waiting for the owner (`members` = 0), ready ("Open engine", same anchor rules as D-06). Polls every 3 s while visible with TanStack Query, stops at ready or expiry; `aria-live="polite"` announces changes only.
- **Engine list:** a new display state `owner-pending` (online with `members` = 0), label "Owner not set up", between `never-seen` and `online` in `deriveEngineDisplayStatus`.
- Intro copy takes the link-code lifetime from configuration; all strings in `en` and `cs`.

## Out of scope

- Install command tabs (D-11), emails (D-12), relay presence itself (R-07). Pricing and the trial length (configuration, Seb).

## Design notes

- `linkCodeId` is not a secret and grants nothing: it only reads the status of a code of the actor's own organization. Another organization's ID answers 404.
- The status endpoint never returns the link code or its hash.
- Repeated trials: once per organization here. Stopping one person from opening many organizations for many trials (card fingerprints in Stripe Radar) is an I-05 abuse topic; note it there.
- Never fetch anything from the engine's hostname (D-06's rule); everything comes from `/api/*`.

## Acceptance criteria

- [ ] Workers tests: Checkout with `trialDays` sends `trial_period_days` and `payment_method_collection: 'always'` the first time and no trial the second; the webhook sets `trialStartedAt`; a `trialing` organization may create link codes.
- [ ] Workers tests for `link-eligibility` and the link-code status endpoint (pending, expired, linked; another organization's ID → 404; no session → 401; the response never contains the code).
- [ ] Client tests with a fake API: each checklist state and its copy, the 2- and 3-minute hints with a fake clock, resume after reload with `?link=`, the plan step before the command, the return from Checkout.
- [ ] `deriveEngineDisplayStatus` returns `owner-pending` for an online engine with `members` 0 (unit test).
- [ ] Both locales complete; axe clean at 360 px.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Stripe test-mode settings for trials are an Apply step ([apply.md](../apply.md)).
- If R-07 is not merged, the "reachable" row stays hidden; X-07 checks it once both are in.
