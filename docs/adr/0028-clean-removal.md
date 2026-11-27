# 0028. Clean removal: one "Remove project", an engine that knows, and a signed unlink

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Seb (roadmap interview and review of 2026-11-27)
- **Builds on:** [ADR 0014](0014-cryptography.md), [ADR 0018](0018-teams-and-member-access.md), [spec, Devices, members and recovery](../spec/zero-trust-spec.md#pairing-and-identity)

## Decisions on the questions raised

Seb accepted the proposals on 2026-11-27:

1. **No undo.** A removal is permanent for the project's identity, as revocation is today. An undo would let a thief with the engine key, or whoever hijacked the dashboard account, reverse a removal made because of them. Recovery from a mistaken or malicious removal is linking again under a new identity, with the data intact and new passkeys.
2. **The engine stops after a removal.** Once told it was removed, the engine stops opening tunnels and sending heartbeats until someone on the server links it again. The platform never touches its data.

## Context

A project can leave the platform in two ways today, and neither tells the engine:

- **Revoke project** (`engine.revoke`, step-up): the answer to a stolen engine key. The engine ID is suspended for good, relays drop it at their next registry refresh (5 minutes), heartbeats and re-registration get `403 engine-suspended`.
- **Delete project** (`team.delete`): the same revoke, then the team is deleted.

People mix them up, and the "stolen key" framing scares those who only hand a server back. The engine is left beating against a 403 with nothing to show. And only someone in the dashboard can remove a project: an owner who lost dashboard access, or a client handing a server back, has no way to do it from the server.

The engine key is the engine's identity: the engine ID is its hash and the hostname derives from it, so it cannot rotate in place (spec). Whoever registers an engine ID gets its hostname routed to them.

## Decision

### a. One "Remove project"

- One action in the UI, **Remove project**, replaces Revoke project and Delete project. It needs a fresh passkey assertion and is permanent for the project's identity.
- The dialog explains, in plain words, why it is permanent: "If this server or its keys may have been copied, removing the project is what stops the copy: nobody can bring it back, not even you. To use the server again, link it as a new project; its data stays." It also shows the uninstall command for the server (d).
- Policy: the placeholder `engine.remove` (`SENSITIVE`) becomes the action, with step-up, and replaces `engine.revoke`. Removing a team's last project no longer deletes the team; with [ADR 0026](0026-teams-v2.md), a team is deleted only when it holds no projects. Until 0026 lands, where a team holds exactly one project, the UI's Remove project also deletes that team.
- Audit and notifications: the org audit log records who removed it; the org's owners and admins and the team's admins are told ([ADR 0027](0027-notifications.md)).
- Billing: a removed project stops counting at once, like a revoked one, and so do its agents and members ([ADR 0025](0025-metering-and-subscriptions.md) counts active engines only). Its tombstone is never a project.

### b. The engine learns it was removed

- `ProblemDetails` gets an optional member `reason`, sent only with `engine-suspended`: `removed` (by its organization, or by itself in c) or `suspended` (by the platform, for abuse or non-payment, and may be lifted). Old engines strip it and behave as today.
- Heartbeats and re-registration of a removed engine get `403 engine-suspended` with `reason: removed`.
- The engine then shows, in its terminal, `ptbk status` and the engine UI where it is still reachable locally: "Removed from app.ptbk.io on <date>. Your data is still on this server. Link again: `ptbk link` (a new identity and address). Uninstall: `ptbk uninstall`."
- It stops opening tunnels and sending heartbeats (decision 2). `ptbk link` makes a new identity, so the old ID is never sent again.
- A platform suspension (`reason: suspended`) changes nothing: the engine keeps beating on its interval, as today, and shows "Suspended by Promptbook; contact support".

### c. Engine-initiated unlink: `ptbk unlink`

The engine removes itself with a request signed by its identity key.

- `POST /v1/engines/{engineId}/unlink`, body `{ "v": 1, "engineId", "ts", "nonce" }`, strictly parsed, at most 1 KiB. `nonce` is 16 random bytes, base64url.
- `Ptbk-Signature: ed25519=<sig>` over `signingInput('ptbk-unlink-v1', origin, sha256(body))`, where `origin` is the dashboard's origin (`https://app.ptbk.io`). A new signing context ([ADR 0014](0014-cryptography.md), [ADR 0010](0010-protocol-design-principles.md) §5), so no other engine signature can be replayed as an unlink, and a staging request cannot be replayed against production.
- The dashboard checks, in this order: size, header, the signature over the raw bytes against the registered public key of the path's engine ID, then the schema, path ID equals body ID, `|now − ts| ≤ 120 s`, and that the nonce is unseen. Nonces are kept 5 minutes. Rate-limited per address and per engine.
- Then it marks the engine removed exactly as (a) does, with the engine as the actor in the audit log, and tells the same people: "Marketing site was removed from its server (`ptbk unlink`)".
- Answers: `200 { "v": 1, "removed": true }`, also for an engine already removed or suspended (idempotent); `401 bad-signature`; `401 stale-timestamp` with `serverTime`; `404` for an unknown engine. A platform suspension becomes a removal, and its abuse record stays.
- This works without any dashboard session: for an owner who lost their account, or a client handing a server back.

### d. Clean uninstall on the engine (engine team)

A brief for the engine team, in the AGENT_BRIEF:

- `ptbk uninstall` runs, in order:
  1. `ptbk unlink`, unless `--offline` or the engine already knows it was removed; if the dashboard cannot be reached, it says so and asks whether to continue offline (the project then stays in the dashboard, offline, until someone removes it there);
  2. stops and disables the service (systemd, launchd or the container);
  3. revokes its TLS certificates through ACME with reason `cessationOfOperation`, best effort;
  4. deletes the engine key, the TLS keys and certificates, the ACME account key, relay tokens, the pinned dashboard member key and any setup secrets;
  5. keeps the data directory by default and prints where it is; `--purge` deletes it after the user types the project's hostname.
- It reports what it removed and what it left. Deleting files on an SSD does not erase them; the output recommends disk encryption for servers that change hands.
- Nothing the platform sends can trigger any of these steps.
- Conformance covers: unlink before wiping, the removed state and its message, no heartbeat or tunnel after removal, `--purge` needing confirmation.

## Threat analysis

What changes in what the platform can do to an engine: telling it that it was removed, after which the engine stops connecting (b). It could already cut transport, so this adds no access and no new lockout. It never touches data or keys. The engine gains one way to act on the platform (c), with its own key.

| Case                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged unlink                           | Needs the engine's private key: the signature is checked against the key registered for that ID, before the body is parsed. Without it, 401.                                                                                                                                                                                                                                                                                                          |
| Replayed unlink                         | `ts` within 120 seconds and a nonce kept for 5 minutes stop a replay inside the window, and a removal is terminal and idempotent, so a replay after it changes nothing. The origin in the signed input stops a replay against another dashboard.                                                                                                                                                                                                      |
| Unlink with a stolen engine key         | A lockout of the real owner, who would have to remove the project anyway once the key is stolen. The thief gains nothing: a removed ID is never routed again.                                                                                                                                                                                                                                                                                         |
| Removal by a hijacked dashboard account | A lockout, not access. It needs a passkey assertion, `SENSITIVE` blocks it during the recovery cooldown, and every org owner and admin is told. The engine shows why it stopped. Recovery: `ptbk link` on the server, a new identity with its data intact; members register passkeys for the new address. No undo, by decision 1.                                                                                                                     |
| A malicious dashboard claims "removed"  | The engine stops connecting, which the platform could already cause by cutting transport. Its data, keys and passkeys stay; linking again works.                                                                                                                                                                                                                                                                                                      |
| The removed ID comes back               | **Tombstones.** The engine row stays, removed, forever: ID, public key and hostname, nothing else. Registration of that ID is refused in every organization, the relay registry never returns it, and the hostname, derived from the key, is never routed again. Without the tombstone, a thief with the key could register the ID into their own organization and serve the old hostname to its users. Tombstones survive deleting the organization. |
| Downgrade                               | An old engine ignores `reason` and keeps beating against the 403, as today. An old dashboard answers the unlink route with 404, and `ptbk unlink` reports that the project must be removed in the dashboard.                                                                                                                                                                                                                                          |

## Contract changes

- `packages/protocol`: `ProblemDetails.reason` (optional enum `removed`, `suspended`); `UnlinkRequest` and `UnlinkResponse` v1; signing context `ptbk-unlink-v1`; `unlinkPath(engineId)`. All additions.
- Dashboard: the unlink route through the typed route helper (auth: engine signature; rate limit per address and engine), a nonce store, `reason` on the 403s, one Remove project in the UI, `engine.remove` with step-up in place of `engine.revoke`, and the removed tombstone detached from organization deletion. The usage event `engine.removed` gains `via: unlinked`.
- Engine (engine team): the removed state and message, stopping after removal, `ptbk unlink`, `ptbk uninstall`. The mock engine and conformance cover the same, including a forged and a replayed unlink.
- Spec: "Engine key compromised" says remove, not revoke; "The platform cannot" adds "and tell an engine it was removed, which stops it connecting"; the metadata table keeps a removed engine's ID, public key and hostname for good.

## Alternatives considered

- **Keep two actions, revoke for compromise and unlink for hand-backs.** A gentle unlink would have to let the same ID come back, and the dashboard cannot tell a hand-back from a compromise. Whoever has the key could then re-register it elsewhere. Rejected.
- **A challenge from the dashboard instead of a nonce.** It needs two round trips and state on the dashboard for each attempt, for the same guarantee. Timestamp and nonce match the heartbeat's model.
- **Reuse the heartbeat's `seq` for replay protection.** It lives in the status Durable Object, not where the route runs, and would tie a one-off request to the heartbeat's lifecycle.
- **The dashboard tells the engine to wipe itself.** A command channel into the engine, and a remote kill switch for anyone who controls the dashboard. Rejected.

## Consequences

- One clear action in the dashboard, and engines that say what happened instead of retrying in silence.
- Owners can leave the platform from the server alone, which also covers lost dashboard accounts and servers handed back.
- A removed identity is gone for good, including after a mistaken removal; linking again means a new address and new passkeys.
- New contract surface for the engine team: the removed state, `ptbk unlink`, `ptbk uninstall`.
