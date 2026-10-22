# U-12. Integrations and tools

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02, C-07
- **Status:** done (#65)
- **Spec:** Security hardening (4 outbound list, 7 secrets), What our platform can and cannot do (write-only credentials); ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

When the engine advertises `integrations@1`, members see what each agent may use (MCP servers, calendars, repositories), with status, scopes, tools, the secrets each references by name and recent activity, and can add, enable, disable, check and remove integrations where permitted, without any secret value ever passing through this UI.

## Context

Integrations reach outside the engine, so owners must see them at a glance and switch them off quickly. Credentials live in the engine's secret store (U-06, write-only); an integration only references secrets by name (C-07 `secretRefs`), and this UI never shows or asks for a value: a missing secret is fixed on `/secrets`. Calendar connections need an engine-side OAuth flow that the contract marks `draft`. The feature registers itself in the registry (U-02); without `integrations@1` nothing of it appears.

## Scope

- Feature module `src/features/integrations/` registered in `src/app/features.ts` with `defineFeature({ id: 'integrations', requires: { capability: integrations@1, permission: 'integrations.read' }, … })`:
  - `nav`: group `resources`, "Integrations", to `/integrations`; `agentTabs`: "Integrations" at `/agents/$agentId/integrations` (agent-specific and engine-wide ones).
  - `agentOverviewCards`: integrations with status, highlighting `needs-attention` and `error`.
  - `activityRenderers`: `integration.*` (version 1) for `integration.connected`, `integration.error`, `integration.used` (tool name).
  - `attention`: count of `needs-attention` and `error`, linking to `/integrations?status=needs-attention,error`.
  - `commands`: "Disable integration" (`integrations.manage`), "Add MCP server", "Go to integrations".
- Routes `/integrations`, `/integrations/$integrationId`, `/agents/$agentId/integrations` with `requireFeature('integrations')`. Typed search params `kind`, `status`, `agentId`, `cursor`, sent to C-07's `GET /integrations`.
- List: `DataTable` in server-side mode: name, kind, agent or "All agents", status badge with text, scopes count, last activity; card layout below 768 px.
- Detail:
  - Kind-specific config: MCP server URL as text (an `ExternalLink` only if `safe-url.ts` allows it), calendar provider and account, GitHub repository (link to `github.com` through the same rule). An unknown kind renders a generic card with `rawKind` and the common fields.
  - Status with `statusDetail` as text; scopes as `Badge`s with text; tools (name, description as plain text).
  - Secret references: name and state (`resolved`, `missing`, `revoked`) as text badges; with `can('secrets.read')` the name links to `/secrets?q=<name>`. No value, no value input.
  - Recent activity from C-07's `GET /activity?integrationId` rendered through the registry's renderers (generic fallback for unknown kinds).
- Actions (`can('integrations.manage')`): add an MCP server (name, URL, agent or engine-wide, secret references picked by name from secret metadata `GET /secrets`, which needs `secrets.read`; without it, names are typed) or a GitHub repository; edit name and references; enable and disable (optimistic with rollback); "Check connection" (`POST /integrations/{id}/check`, waits, shows the new status); delete with `ConfirmDialog`. Forms use the `@ptbk/ui` form layer with zod; server validation errors map with `applyServerErrors`.
- Calendar: shown as "Connect calendar" disabled with an explanation while the contract route is `draft`; existing calendar integrations are fully viewable.
- Live: `integration.changed` events and `integration.*` activity invalidate the affected list and detail; nothing polls.
- Hooks `useIntegrations(filters)`, `useIntegration(id)`, `useIntegrationMutations()`, `integrationKeys` and `queryOptions` shared with loaders.

## Out of scope

- Entering or rotating secret values (U-06). Calendar OAuth (engine-side, `draft`). Per-tool approvals (not in C-07 yet). Tool invocation from the UI.

## Design notes

- Integration config, tool descriptions and status details come from the engine and partly from third parties: text only, never markdown or HTML; URLs only through `safe-url.ts`.
- The add form holds no secret value, so it needs no `SensitiveInput`; a test asserts no `password` input exists in this feature.
- Status uses an exhaustive `switch` over C-07's union with an "unknown" fallback.
- Design-system components and semantic tokens only.

## Acceptance criteria

- [ ] With seeded integrations: kind, status and agent filters and the cursor are written to the URL and restored on reload; paging reaches every integration.
- [ ] Detail renders each kind's config, scopes, tools and secret references; a `missing` reference shows text and, with `secrets.read`, a link to `/secrets`; without it, no link.
- [ ] Canary test: seed a secret with a random canary value referenced by an integration; after visiting list, detail, add and edit, the canary is absent from `document.body` (incl. attributes), the serialised query cache and every toast.
- [ ] An unknown integration kind renders the generic card with `rawKind`; a `javascript:` MCP URL renders as text without `href`.
- [ ] Enable and disable roll back on error with a failure toast; check connection shows the returned status; delete requires confirmation; without `integrations.manage` no action controls exist.
- [ ] Recent activity renders known kinds through the registered renderers and an unknown kind through the fallback card.
- [ ] Without `integrations@1` the nav item, agent tab and card are absent and `/integrations` shows "not available on this engine".
- [ ] Skeleton, empty, no-results and error states each have a test; `axe-core` passes; `test:csp` visits list, detail and add form with zero violations and passes the UX checks (360 px without overflow, layout shift, reduced motion); routes stay within their bundle budgets.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Outbound destinations on the security panel (U-06) and integration URLs overlap; whether the engine derives one from the other is for the engine team.
- Per-tool approvals are likely the next contract addition (`integrations@2` or an additive field); keep the tools list a component that can grow controls.
