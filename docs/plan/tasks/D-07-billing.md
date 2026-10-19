# D-07. Billing with Stripe

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-02, D-09
- **Status:** todo
- **Spec:** Goal and scope; Decisions (Billing); Metadata we still see (Account email, billing details); Legal and GDPR (sub-processors); Abuse on our domains (item 4); ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0007](../../adr/0007-frontend-stack.md), [0009](../../adr/0009-drizzle-and-migrations.md)

## Goal

An organization owner can subscribe through Stripe Checkout and manage payment methods and invoices through the Stripe customer portal; signature-verified webhooks keep the organization's billing state in D1, and platform admins see who is past due.

## Context

Per ADR 0006 the organization, not the user, owns the Stripe customer and the subscription, so team billing later needs no migration. Billing is not technically enforced against a modified engine; the terms of service cover it. Nothing is suspended automatically: suspension for non-payment is a manual platform admin action (the suspend flow itself is I-05). Card data never touches us; Stripe holds it. I-05 later uses this task's billing state for the "card on file before creating engines" rule in D-03's `EngineCreationPolicy`.

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

- `BillingProvider` port (`createCustomer`, `createCheckoutSession`, `createPortalSession`, `getSubscription`, `verifyWebhook`) with a Stripe adapter and an in-memory fake. The fake is selectable with `adapters.billing = 'fake'` (dev and the X-05 e2e stack only; D-01's config refuses it elsewhere): its Checkout session completes at once, upserting the org's subscription as `active` through the same code path the webhook uses, and returns `/billing?checkout=success` as the URL; its portal returns `/billing`. So billing never blocks linking an engine in tests. Use the official `stripe` package (newest version at least 7 days old) with its fetch HTTP client and SubtleCrypto provider, or plain `fetch` plus WebCrypto if the SDK does not run cleanly on Workers.
- Authorizer actions: `billing.read` and `billing.manage` (`owner` in v0); `billing.owner.change` already exists from D-02 as `sensitive` (no route for it yet, since v0 orgs have one owner).
- SPA routes built from `@ptbk/ui` components in D-09's shell, strings through i18n, and `/api/*` endpoints declared in D-01's route table:
  - `/billing`: plan, status, renewal date, buttons "Subscribe" (Checkout) or "Manage billing" (portal); data from `GET /api/billing`.
  - `POST /api/billing/checkout` and `POST /api/billing/portal` create the Stripe customer on first use (email = the acting owner's email, metadata `org_id` only), then a Checkout session in subscription mode with the configured price ID, or a portal session, and return `{ url }`; the SPA navigates to it top-level. Success and cancel URLs point back to `/billing`. No Stripe.js on our pages, so the CSP stays `script-src 'self'`.
  - `/admin/billing` (platform admin, via `Authorizer`, data from `GET /api/admin/billing`): a `DataTable` of organizations whose status is `past_due`, `unpaid` or `canceled`, with a link to their engines for the manual suspend action (I-05).
- `POST /webhooks/stripe` in the Hono `/webhooks` router: raw body read once (the signature covers the bytes, so no JSON validator middleware before verification), `Stripe-Signature` verified with the webhook secret and a 5-minute tolerance (400 on failure), event ID deduplicated, then handled: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`. Unknown types → 200 and ignored. For subscription events, re-fetch the subscription from Stripe and upsert it, so out-of-order delivery cannot leave stale state.
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
- [ ] Migration is drizzle-kit output and passes D-01's guards; schema allowlist updated; `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- **Pricing model is undecided** (per engine, per agent from heartbeat counts, flat, trial or not). Keep the price ID in config and quantity unset until decided.
- Whether a trial or an active subscription is required before linking an engine is a business decision for I-05's policy.
- Stripe Tax, VAT handling and invoice language (English/Czech) need a decision before the paid launch.
