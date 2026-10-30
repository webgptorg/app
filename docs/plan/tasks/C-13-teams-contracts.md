# C-13. Teams contracts: member key, access tickets, revocations, heartbeat v2

- **Lane:** Contracts · **Module:** `packages/protocol`, `packages/engine-api`, `packages/conformance` · **Milestone:** M3
- **Depends on:** —
- **Status:** in progress (feat/c-13-teams-engine-api)
- **Spec:** [Teams](../../spec/teams.md) "Contracts"; ADRs: [0018](../../adr/0018-teams-and-member-access.md)

## Goal

The contracts for teams exist, with vectors and conformance checks:

- the dashboard member key;
- signed access tickets and member revocations;
- heartbeat v2 and its reply;
- the access-request routes, `Member.dashboardUserId` and the dashboard-removals setting.

## Scope

- **Protocol:**
  - `AccessTicket` and `MemberRevocation`: schemas, signing and verification (purposes `ptbk-access-ticket-v1` and `ptbk-member-revocation-v1`) with test vectors;
  - `memberKey` in the registration response;
  - `HeartbeatV2` (`accessRequests`, `acks`) next to v1, and `HeartbeatReply` (`revocations`).
- **Engine API:**
  - `/access-requests` list, approve (`{ code, role }`, step-up) and decline;
  - `Member.dashboardUserId`, the `dashboardRemovals` setting, and `/auth/join` added to `gateway.md`;
  - the member and invite drafts made final.
- **Conformance:**
  - tickets: forged, expired, replayed, wrong engine, over the pending cap;
  - approve: wrong code, missing step-up;
  - revocations: forged, replayed, last owner, switched off;
  - heartbeat v2 acks.
- Update `docs/engine-integration` (engine-api.md, gateway.md, checklist rows) for the engine team.

## Out of scope

- The mock engine (M-09), the dashboard (D-13) and the UI (U-15).

## Acceptance criteria

- [ ] Vectors and reject-path tests for both signed messages; coverage thresholds hold.
- [ ] Heartbeat v1 is unchanged and still accepted.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Size caps for tickets and the reply; keep the heartbeat body under its 4 KiB cap with 32 acks.
