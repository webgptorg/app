# D-07. Billing with Stripe

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-02 · **Unblocks:** — (M3 completion; I-05 uses its billing state)
- **Status:** todo
- **Spec:** Goal and scope; Decisions (Billing); Metadata we still see (Account email, billing details); Legal and GDPR (sub-processors); Abuse on our domains (item 4); ADRs: [0006](../../adr/) (Organizations, members and roles from day one)

## Goal

An organization owner can subscribe through Stripe Checkout and manage payment methods and invoices through the Stripe customer portal; signature-verified webhooks keep the organization's billing state in D1, and platform admins see who is past due.

## Context

Per ADR 0006 the organization, not the user, owns the Stripe customer and the subscription, so team billing later needs no migration. Billing is not technically enforced against a modified engine; the terms of service cover it. Nothing is suspended automatically: suspension for non-payment is a manual platform admin action (the suspend flow itself is I-05). Card data never touches us; Stripe holds it. I-05 later uses this task's billing state for the "card on file before creating engines" rule in D-03's `EngineCreationPolicy`.

## Scope

- Migration `0005_billing.sql`:
  - `billing_customers(org_id TEXT PK REFERENCES organizations, stripe_customer_id TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL)`
  - `subscriptions(org_id TEXT PK, stripe_subscription_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, price_id TEXT NOT NULL, quantity INTEGER, current_period_end INTEGER, cancel_at_period_end INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
  - `stripe_events(event_id TEXT PK, type TEXT NOT NULL, received_at INTEGER NOT NULL)` for idempotency, pruned after 30 days.
- `BillingProvider` port (`createCustomer`, `createCheckoutSession`, `createPortalSession`, `getSubscription`, `verifyWebhook`) with a Stripe adapter and an in-memory fake. The fake is selectable with `adapters.billing = 'fake'` (dev and the X-05 e2e stack only; D-01's config refuses it elsewhere): Checkout and portal redirect to a local `/billing?fake=success` page that marks the org `active`, so billing never blocks linking an engine in tests. Use the official `stripe` package (newest version at least 7 days old) with its fetch HTTP client and SubtleCrypto provider, or plain `fetch` plus WebCrypto if the SDK does not run cleanly on Workers.
- Authorizer actions: `billing.read` and `billing.manage` (`owner` in v0); `billing.owner.change` already exists from D-02 as `sensitive` (no route for it yet, since v0 orgs have one owner).
- Routes (strings through i18n):
  - `/billing`: plan, status, renewal date, buttons "Subscribe" (Checkout) or "Manage billing" (portal).
  - POST actions create the Stripe customer on first use (email = the acting owner's email, metadata `org_id` only), then a Checkout session in subscription mode with the configured price ID, or a portal session; redirect to the returned URL. Success and cancel URLs point back to `/billing`.
  - `/admin/billing` (platform admin, via `Authorizer`): organizations whose status is `past_due`, `unpaid` or `canceled`, with a link to their engines for the manual suspend action (I-05).
- `POST /webhooks/stripe` in the API router: raw body, `Stripe-Signature` verified with the webhook secret and a 5-minute tolerance (400 on failure), event ID deduplicated, then handled: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`. Unknown types → 200 and ignored. For subscription events, re-fetch the subscription from Stripe and upsert it, so out-of-order delivery cannot leave stale state.
- Config and secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (Workers secrets), `STRIPE_PRICE_ID` (var). Test-mode keys in dev and staging, live keys only in production.

## Out of scope

- Usage-based or per-agent metering from heartbeat counts (open point).
- Any automatic suspension or feature gating on billing state; the suspend flow (I-05); invoices or tax logic beyond what Stripe provides.

## Design notes

- Domain: `src/domain/billing/` holds `BillingState = { kind: 'none' } | { kind: 'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled', currentPeriodEnd }` and the mapping from Stripe statuses; adapters translate Stripe objects into it.
- Never store card details, billing addresses or invoice contents; Stripe is the system of record.
- Webhook handler is idempotent and fast; it writes D1 and returns. No emails from webhooks in v0.
- Log event ID and type only, never payloads.

## Acceptance criteria

- [ ] Unit tests: Stripe status → `BillingState` mapping, including unknown statuses mapped to a safe default.
- [ ] With `adapters.billing = 'fake'`, a new org reaches `active` through the fake Checkout without network access (test), and X-05 can link an engine without touching Stripe.
- [ ] Workers tests with the fake provider and a known webhook secret: valid signature → state updated; bad signature → 400; timestamp older than 5 minutes → 400; same event twice → processed once; unknown event type → 200 with no change; `subscription.deleted` → `canceled`.
- [ ] Org scoping: a user of org B cannot open org A's billing page or create a portal session for org A's customer (403); the Stripe customer is keyed by `org_id`, not user.
- [ ] `/admin/billing` is denied to non-admins and lists only problem states.
- [ ] Manual check against Stripe test mode recorded in the PR: Checkout completes, webhook arrives, portal opens.
- [ ] Schema allowlist updated; `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- **Pricing model is undecided** (per engine, per agent from heartbeat counts, flat, trial or not). Keep the price ID in config and quantity unset until decided.
- Whether a trial or an active subscription is required before linking an engine is a business decision for I-05's policy.
- Stripe Tax, VAT handling and invoice language (English/Czech) need a decision before the paid launch.
