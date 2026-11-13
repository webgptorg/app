# 0017. Billing through entitlements

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

Stripe will handle billing, but plans and pricing are not decided (per engine, per seat, per agent, free tier, trials). Billing is not enforced on the engine itself (terms of service, spec). Business features must be addable without refactoring the dashboard.

## Decision

- Stripe stays behind the `BillingProvider` port (D-07); the organisation owns the customer and subscription ([ADR 0006](0006-organizations-and-roles.md)).
- **Entitlements are the only thing the rest of the dashboard asks:** an `Entitlements` port with `allows(orgId, feature)` and `limit(orgId, quota)` (e.g. `engines.create`, `engines.max`, `custom-domains.max`, later `members.max`). Code never checks plan names or Stripe objects.
- **Plans are configuration**, not code: a typed plan catalogue maps Stripe products and prices to features and quotas. Webhooks update the organisation's subscription state in D1; entitlements are computed from it.
- Gated actions show a clear upgrade path in the UI; nothing on the engine depends on it.

## Consequences

- Pricing changes touch the plan catalogue and the webhook mapping only.
- Trials, coupons, team plans and usage-based add-ons fit the same port.

## Update 2026-11-04: billing off on staging

Staging does not charge; production does (Seb). A third billing adapter, `off`, is allowed in dev and staging and refused in production: no provider, no Stripe secrets or IDs, and the entitlements port answers from one configured grant, `BILLING_OFF_PLAN`, for every organization. Stripe routes are not mounted and the SPA shows no billing. Nothing is written to the billing tables while off, so switching staging to `stripe` is a config change: every organization then starts on `none` and subscribes through Checkout. Production keeps `stripe` and the design above, unchanged.


## Superseding decision, 13 November 2026

The new website offer follows [ADR 0021](0021-website-license-authority.md). The website is the commercial authority; App consumes numeric grants and displays advisory coverage. Earlier card-before-install and hard billing gates do not apply to this offer. Legacy Stripe data stays intact.
