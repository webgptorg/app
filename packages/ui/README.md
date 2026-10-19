# @ptbk/ui

The design system shared by `apps/engine-ui` and `apps/dashboard`: design tokens (Tailwind 4 theme, light and dark), accessible components, form primitives, TanStack Table wrappers (`DataTable`), and i18n helpers that work with each app's Paraglide catalogue.

CSP-safe by construction (no runtime style injection, no inline scripts, no `innerHTML`), because engine-ui runs under the engine's strict CSP. It imports no app and no contract package; app-specific concerns such as permissions and API clients stay in the apps. Private, not a contract. Plan: task U-02 ([ADR 0007](../../docs/adr/0007-frontend-stack.md)).
