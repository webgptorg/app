# 0006. Organizations, members and roles from day one

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

v0 has one person per account and one owner per engine. Later, companies will have several users with roles, org billing, and eventually SSO and SCIM (spec roadmap). Retrofitting tenancy into a single-user data model and permission checks is expensive and error-prone.

## Decision

**Dashboard**

- An `Organization` owns engines, the billing customer and the subscription. A `User` belongs to organizations through a `Membership` with a role.
- In v0, sign-up creates a user, a personal organization and an `owner` membership. There is no UI for more members yet.
- Every query is scoped by `orgId`. A session carries the user and the active organization.

**Engine and engine-ui**

- The engine API exposes the current member, their role and an explicit list of permissions (`agents.read`, `agents.delete`, `secrets.manage`, ...).
- Every mutating endpoint declares the permission it requires; without it the engine answers 403. The conformance suite checks this.
- Members are listed in v0; invites and role changes come later on the same shapes.

**Everywhere**

- Authorization goes through one policy port (`Authorizer.can(actor, action, resource)`), deny by default. Code checks permissions, never role names.
- Audit entries record the acting member, the action and the target.

## Consequences

- Adding members, invites, roles, org billing or SSO is additive; no ownership migration.
- Slightly more structure in v0 (an organization per user, a permission list nobody but the owner uses yet).
- The UI renders by capability, so a new role needs no UI change.
