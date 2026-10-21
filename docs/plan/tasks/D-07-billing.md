# D-07. Billing with Stripe and entitlements

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-02, D-09
- **Status:** done (#36)
- **Spec:** Goal and scope; Decisions (Billing); Metadata we still see (Account email, billing details); Legal and GDPR (sub-processors); Abuse on our domains (item 4); ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0007](../../adr/0007-frontend-stack.md), [0009](../../adr/0009-drizzle-and-migrations.md), [0014](../../adr/0014-cryptography.md), [0017](../../adr/0017-billing-entitlements.md)

## Goal

An organization owner can subscribe through Stripe Checkout and manage payment methods and invoices through the Stripe customer portal; signature-verified webhooks keep the organization's billing state in D1; an `Entitlements` port computed from that state and a typed plan catalogue is the only thing the rest of the dashboard asks; and platform admins see who is past due.

## Context

Per ADR 0006 the organization, not the user, owns the Stripe customer and the subscription, so team billing later needs no migration. Billing is not technically enforced against a modified engine; the terms of service cover it. Nothing is suspended automatically: suspension for non-payment is a manual platform admin action (the suspend flow itself is I-05). Card data never touches us; Stripe holds it. Plans and pricing are not decided (ADR 0017), so features are gated only through entitlements: D-03 asks `entitlements.allows(orgId, 'engines.create')` and `entitlements.limit(orgId, 'engines.max')` before creating an engine, and no code checks plan names or Stripe objects.

## Scope

- Tables in `src/adapters/db/schema.ts` (drizzle-kit generates the migration); `stripe_events` is for idempotency, pruned after 30 days:

  ```ts
  export const billingCustomers = sqliteTable('billing_customers', {
    orgId: text('org_id')
      .primaryKey()
      .references(() => organizations.id),
    stripeCustomerId: text('stripe_customer_id').notNull().unique(),
    createdAt: integer('created_at').notNull(),
  });

  export const subscriptions = sqliteTable('subscriptions', {
    orgId: text('org_id').primaryKey(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
    status: text('status').notNull(),
    priceId: text('price_id').notNull(),
    quantity: integer('quantity'),
    currentPeriodEnd: integer('current_period_end'),
    cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  });

  export const stripeEvents = sqliteTable('stripe_events', {
    eventId: text('event_id').primaryKey(),
    type: text('type').notNull(),
    receivedAt: integer('received_at').notNull(),
  });
  ```

- `BillingProvider` port (`createCustomer`, `createCheckoutSession`, `createPortalSession`, `getSubscription`, `verifyWebhook`) with a Stripe adapter and an in-memory fake. The fake is selectable with `adapters.billing = 'fake'` (dev and the X-05 e2e stack only; D-01's config refuses it elsewhere): its Checkout session completes at once, upserting the org's subscription as `active` through the same code path the webhook uses, and returns `/billing?checkout=success` as the URL; its portal returns `/billing`. So billing never blocks linking an engine in tests. Use the official `stripe` package pinned to `stripe@22.6.2` (exact) with `Stripe.createFetchHttpClient()`.
- **Entitlements** (`src/domain/billing/entitlements.ts`, ADR 0017): port `Entitlements { allows(orgId, feature: Feature, signal): Promise<boolean>; limit(orgId, quota: Quota, signal): Promise<number | null> }` (`null` means unlimited), with closed unions `Feature = 'engines.create'` and `Quota = 'engines.max' | 'custom-domains.max'` (later `members.max`). Adapter `SubscriptionEntitlements` reads the org's subscription (org-scoped) and resolves it through the plan catalogue; an in-memory fake with per-org overrides for tests. Which plan applies: `active` and `trialing` use the subscribed plan; `past_due` keeps it (no automatic downgrade, like no automatic suspension); `canceled`, `unpaid` and no subscription fall to the `none` plan.
- **Plan catalogue** (`src/app/config/plans.ts`): a typed, zod-validated object parsed once in `app/` with the rest of the config: `plans: [{ id, stripeProductId, stripePriceId, features: Feature[], quotas: Record<Quota, number | null> }]` plus a `none` plan for organizations without a subscription. Price IDs per environment come from vars; the values are placeholders until pricing is decided. Validation rejects duplicate IDs or price IDs, unknown features or quotas, and a missing `none` plan.
- Authorizer actions: `billing.read` and `billing.manage` (`owner` in v0); `billing.owner.change` already exists from D-02 as `sensitive` (no route for it yet, since v0 orgs have one owner).
- SPA routes built from `@ptbk/ui` components in D-09's shell, strings through i18n, and `/api/*` endpoints declared in D-01's route table:
  - `/billing`: plan, status, renewal date, current entitlements (features and quotas with usage where known, e.g. engines used of `engines.max`), buttons "Subscribe" (Checkout, per catalogue plan) or "Manage billing" (portal); data from `GET /api/billing`, which returns the billing state and the org's entitlements so any gated action elsewhere can show a clear upgrade path.
  - `POST /api/billing/checkout` and `POST /api/billing/portal` create the Stripe customer on first use (email = the acting owner's email, metadata `org_id` only), then a Checkout session in subscription mode for the `planId` in the request body (looked up in the catalogue; unknown → 400), or a portal session, and return `{ url }`; the SPA navigates to it top-level. Success and cancel URLs point back to `/billing`. No Stripe.js on our pages, so the CSP stays `script-src 'self'`.
  - `/admin/billing` (platform admin, via `Authorizer`, data from `GET /api/admin/billing`): a `DataTable` of organizations whose status is `past_due`, `unpaid` or `canceled`, with a link to their engines for the manual suspend action (I-05).
- `POST /webhooks/stripe` in the Hono `/webhooks` router: raw body read once (the signature covers the bytes, so no JSON validator middleware before verification) and verified with `stripe.webhooks.constructEventAsync(await c.req.text(), sig, secret, 300, Stripe.createSubtleCryptoProvider())` (the synchronous `constructEvent` needs Node's crypto and fails on Workers; 300 s tolerance; 400 on failure), event ID deduplicated, then handled: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`. Unknown types → 200 and ignored. For subscription events, re-fetch the subscription from Stripe and upsert it, so out-of-order delivery cannot leave stale state. Entitlements are computed from the stored row on read, never cached separately, so a webhook changes them at once.
- Config and secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (Workers secrets), the plan catalogue's price IDs (vars, replacing a single `STRIPE_PRICE_ID`). Test-mode keys in dev and staging, live keys only in production.

## Out of scope

- Usage-based or per-agent metering from heartbeat counts (open point).
- Any automatic suspension, and any gating that does not go through `Entitlements`; the suspend flow (I-05); invoices or tax logic beyond what Stripe provides.
- Choosing plans and prices (a business decision; only the catalogue changes when it is made).

## Design notes

- Domain: `src/domain/billing/` holds `BillingState = { kind: 'none' } | { kind: 'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled', currentPeriodEnd }` and the mapping from Stripe statuses; adapters translate Stripe objects into it.
- The rest of the dashboard depends on `Entitlements` only; `BillingProvider`, Stripe objects and plan IDs stay inside `src/domain/billing/` and its adapters (an ESLint `no-restricted-imports` rule or a test enforces it).
- Never store card details, billing addresses or invoice contents; Stripe is the system of record.
- Webhook handler is idempotent and fast; it writes D1 and returns. No emails from webhooks in v0.
- Log event ID and type only, never payloads.

## Acceptance criteria

- [x] Unit tests: Stripe status → `BillingState` mapping, including unknown statuses mapped to a safe default.
- [x] Entitlements tests with a test catalogue: each `BillingState` resolves to the expected plan (`past_due` keeps it, `canceled`, `unpaid` and none fall to `none`); `allows` and `limit` return the plan's values, `null` for unlimited; reads are scoped by `orgId`.
- [x] Catalogue validation tests: duplicate plan or price IDs, an unknown feature or quota, and a missing `none` plan are rejected at config parse; Checkout with an unknown `planId` → 400.
- [x] `GET /api/billing` returns the org's entitlements; a test asserts no module outside billing imports `BillingProvider` or compares plan IDs.
- [x] With `adapters.billing = 'fake'`, a new org reaches `active` through the fake Checkout without network access (test), and X-05 can link an engine without touching Stripe.
- [x] Workers tests with the fake provider and a known webhook secret: valid signature → state updated; bad signature → 400; timestamp older than 5 minutes → 400; same event twice → processed once; unknown event type → 200 with no change; `subscription.deleted` → `canceled`.
- [x] Org scoping: a user of org B cannot open org A's billing page or create a portal session for org A's customer (403); the Stripe customer is keyed by `org_id`, not user.
- [x] `/admin/billing` is denied to non-admins and lists only problem states.
- [x] Manual check against Stripe test mode: moved to "Apply (needs credentials)" below.
- [x] Migration is drizzle-kit output and passes D-01's guards; schema allowlist updated; `bun run check` passes.
- [x] **Status** line above set to `done (#<PR>)`.

## Follow-up (no credentials)

- A contract test of the real Stripe adapter against `stripe/stripe-mock` in CI (today it is tested only against a hand-written `StripeApi` fake), as a separate PR with `Refs: D-07`.

## Apply (needs credentials)

Tracked in [apply.md](../apply.md).

- Manual check against Stripe test mode, recorded on the D-07 tracking issue or a follow-up PR: Checkout completes, the webhook arrives, the portal opens. It needs only a Stripe test-mode account (a test product and price, customer portal settings saved once, a restricted `rk_test_` key and the `whsec_` secret from `stripe listen --forward-to` against `wrangler dev`), not staging.

## Risks and open points

- **Pricing model is undecided** (per engine, per seat, per agent from heartbeat counts, flat, trial or not). Keep plans in the catalogue and quantity unset until decided; usage-based add-ons fit the same port (ADR 0017).
- Whether a trial or an active subscription is required before linking an engine is a business decision; it is expressed as the `none` plan's `engines.create` and `engines.max`, not in code.
- Stripe Tax, VAT handling and invoice language (English/Czech) need a decision before the paid launch.
