# 0018. Teams, access requests and dashboard removals

- **Status:** Proposed
- **Date:** 2026-10-30

## Context

Agencies need several people on one engine and several engines under one bill ([teams spec](../spec/teams.md)). Today an organization has one owner, and the engine adds people only through an invite link that someone already on the engine creates.

The meeting of 2026-10-23 found two gaps:

- An org admin who isn't on an engine can't add anyone to it.
- An org admin can't remove anyone from it either.

The zero-trust promise is that our platform cannot add users or passkeys to an engine ([spec](../spec/zero-trust-spec.md#what-our-platform-can-and-cannot-do)).

## Decision

1. **Organization → teams → people.**
   - Teams are flat, and a user can be in several of them.
   - A team has its own table and, in v1, at most one engine (a unique `engines.teamId`).
   - Members, invites and requests belong to the team, so several engines per team later is additive.
2. **Org roles are owner, admin and member.** Owners and admins manage teams and people; only owners manage billing and roles.
3. **The dashboard invites, the engine grants.**
   - The dashboard gives an invited person a short-lived ticket, signed with a dedicated dashboard member key that the engine pins at registration.
   - With it, the person registers a passkey on the engine as an access request.
   - Someone with `members.manage` approves after typing the 6-digit code shown to the person.
   - The dashboard alone can never add a member.
4. **The dashboard may revoke.**
   - A signed member revocation, delivered in the heartbeat reply, makes the engine disable a member who joined through the dashboard.
   - It never applies to the last owner.
   - The engine owner can switch it off.
   - This widens what the platform can do from "cut transport" to "remove people it brought in", which is a lockout, never access.
5. **The heartbeat gets a new version** with a pending-request count and acks keyed by IDs the dashboard issued. It still carries no names or free text.

## Consequences

- Agencies get the structure the meeting asked for. Org admins can offboard people without being on every engine, and onboarding needs one approval by someone on the engine.
- The "platform cannot" list gains an exception. It is limited to revocation, opt-out, and visible in the engine's audit log. The internal security review (I-06) has to cover the member key and both signed messages.
- New contract surface for the engine team:
  - the join gateway page and access-request routes;
  - heartbeat v2 and the heartbeat reply;
  - the pinned member key.
- Engines without it keep invite links only.
- The dashboard's view of who is on an engine can lag, or miss members added by invite link. The engine stays the authority.
