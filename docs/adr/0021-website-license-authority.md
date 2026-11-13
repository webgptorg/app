# 0021. Website owns commercial licenses; App coverage is advisory

- **Status:** Accepted by product owner, 13 November 2026; implementation review in this PR
- **Supersedes:** ADR 0017's application-owned Stripe catalog and billing gates for the new website offer

The website/member area owns customer identity verification, purchases, subscriptions, the explicit 14-day no-card Business trial, discounts and license grants. App owns engine registration, routing, control access and status. Community seats remain entirely on the website.

Select `ADAPTERS.billing = website` after coordinating deployment. This mounts no App Stripe Checkout, portal or webhook routes and supplies advisory entitlements: missing/expired/over-capacity licenses never deny engine creation or control. Authentication, ownership, roles, CSRF, abuse/rate limits, revocations and engine-origin passkeys keep their existing authority. Existing Stripe records remain intact for reconciliation; never create two subscriptions for the same customer.

The server polls the website every 15 minutes with its dedicated server credential and stable linked subject. The HTTP contract in `docs/design/website-licensing.md` carries numeric/boolean grants, including heterogeneous, historical/custom and unlimited allocations. Neither a plan name nor a price is application logic. App may rearrange coverage among engines; website stores no permanent engine assignment. A failed sync retains the last known snapshot and shows uncertainty. It cannot suspend an engine.

Website identity handoff is a separate operation from pairing an engine. It is challenge-bound, expires in 60 seconds and is exchanged once server-to-server. It carries verified account identity only, no engine key, content, member authorization or passkey assertion. Existing account linking requires an authenticated matching-email actor; this PR does not silently recover an unrelated existing account. An App-first login remains supported. Email changes and re-linking need a later explicit account flow.

Heartbeat v1's `agents` counts all agents and `members` counts registered engine members. Neither is silently relabeled a specialist or a controlling-user quota. Unknown usage stays unknown until the additive engine usage contract is deployed.
