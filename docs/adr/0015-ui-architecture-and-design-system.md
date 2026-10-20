# 0015. UI architecture and design system

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

Engine UI and dashboard share one stack ([ADR 0007](0007-frontend-stack.md)) and one design system (`packages/ui`). The product must look polished and personal, keep the Promptbook identity, and allow a full visual redesign later (the designer, Anka, will do a visual pass) without touching feature code. The product brief is [docs/design/ui.md](../design/ui.md).

## Decision

- **Three token layers**, all CSS custom properties defined in `packages/ui`:
  1. _Primitives_: raw palette, type scale, spacing, radii, shadows, durations, easings (e.g. `--ptbk-cyan-300`).
  2. _Semantic_: meaning, not colour (`--color-surface`, `--color-text-muted`, `--color-accent`, `--color-success`, `--color-danger`, `--color-focus`, `--motion-enter`), with light and dark values.
  3. _Component_: per component where it needs its own knobs (`--button-primary-bg`), defaulting to semantic tokens.

  Feature code and components use semantic or component tokens only; primitives appear in exactly one place, the theme. A redesign or a white-label theme swaps primitives and semantic mappings; nothing else changes. Tailwind 4's `@theme` maps tokens to utilities.

- **One component per module** in `packages/ui` (`components/button/`, `components/dialog/` …), each with its own tokens, stories in the CSP test gallery, and tests. Composite patterns (`DataTable`, `EmptyState`, `TrustMark`, `EngineSwitcher`) are modules too. Apps never restyle a component ad hoc; they use variants or tokens.
- **Identity kept, elevated:** Outfit for display, Inter for UI text (self-hosted), Promptbook cyan/mint as the accent used sparingly (primary actions, focus, live status), neutral surfaces, ink for dark surfaces, generous whitespace, soft layered shadows. Light and dark mode from day one.
- **Motion as part of the system:** duration and easing tokens; CSS transitions and keyframes for most motion; the View Transitions API for route and layout changes; `motion` (CSP-safe: it animates through the CSSOM, no inline style tags) only where choreography needs it. Every animation respects `prefers-reduced-motion`. Motion explains state (something arrived, completed, is live); it never decorates.
- **Feature modules** in each app: a feature (agents, runs, files, triggers, integrations, members, security…) is a folder that registers its routes, navigation entry, permission and capability requirements in a typed registry ([ADR 0016](0016-engine-capabilities.md)). The shell renders what the registry and the engine allow.

## Consequences

- The visual pass later is a theme change plus component polish, not a rewrite.
- A little more ceremony per component (tokens, gallery entry, tests).
- Consistent look across the engine UI and the dashboard by construction.
