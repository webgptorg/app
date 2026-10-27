# D-12. "Engine online" and "back online" emails, offline hint

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-05, M-08
- **Status:** in progress (feat/d-12-engine-online-emails)
- **Spec:** Operations (Engine offline; Notifications without us); What our platform can and cannot do; design: [onboarding.md](../../design/onboarding.md) (Journey 1 step 4, Engine offline)

## Goal

The dashboard emails the owner when a newly linked engine sends its first heartbeat ("Your engine is online, finish setup on its terminal") and when an engine that was reported offline comes back, and the engine page tells an owner of an offline engine what to run on the server.

## Context

D-05 sends one "Your engine {hostname} is offline" email per outage and nothing else. People often walk away during the image download; a first-online email brings them back to the step only they can do. The command names in the copy follow the mock engine's reference CLI (M-08) and the guide.

## Scope

- In the `EngineStatus` Durable Object (D-05): on the first accepted heartbeat of an engine, enqueue a "first online" email once per engine ID; on the first heartbeat after an outage that sent an offline email, enqueue "back online". Both use the existing alert recipients, retries and idempotency of the offline email.
- Copy (`en`, `cs`), no content from the engine:
  - "Your engine {hostname} is online". Body: "Finish setup on the engine's terminal: it shows a setup link that makes you the owner. We cannot send that link, because only the engine can make you its owner." Link to the engine page.
  - "Your engine {hostname} is back online". Body: since when, how long it was offline.
- Skip the first-online email when heartbeat `members` is already ≥ 1 (an engine that had an owner before linking, Journey 2b).
- Engine page, offline: "Last seen {time}. If the server is up, run `promptbook-engine status` on it." with a link to the guide's troubleshooting.

## Out of scope

- Push notifications (engine-side Web Push). Emails for other states.

## Design notes

- Emails carry the hostname and times only, no setup link and nothing from inside the engine.

## Acceptance criteria

- [ ] Durable Object tests with a fake clock and a fake email sender: exactly one first-online email; none when `members` ≥ 1; one back-online email after an offline email, none after a gap shorter than the offline threshold.
- [ ] Both locales complete.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- If the owner is on the link page when the first heartbeat arrives, the email is redundant; acceptable in v0 (no presence tracking).
