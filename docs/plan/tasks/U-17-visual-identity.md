# U-17. Visual identity v1: calm precision across the app

- **Lane:** U · **Module:** `packages/ui`, `apps/engine-ui`, later `apps/dashboard` · **Milestone:** M5
- **Depends on:** U-16
- **Status:** done (#294)
- **Spec:** —; ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md); brief: [ui.md](../../design/ui.md)

## Goal

The whole app gets the identity the chat introduced in U-16: calm, precise and readable, for technical and non-technical users alike. It replaces the provisional look (bordered white cards, underlined links, teal everywhere). Decided with Seb on 2026-11-13; the baseline screenshots and audit are attached to the first PR.

## Identity

- **Direction:** calm precision, Linear-style. Neutral graphite chrome. Colour comes from agents (the U-16 palette, `--color-agent-1..8` or the profile colour) and from status (success, warning, danger, info). Teal stays only for focus rings, links in prose and selection.
- **Primary buttons:** near-black in light, near-white in dark. Dark mode is never loud: no bright cyan, no black slabs for neutral pills, no saturated banner fills.
- **Theme:** follows the system. Light and dark are designed to the same standard, and the manual switch stays.
- **Type:** Inter everywhere; Outfit is removed. Headings use Inter in tighter, heavier cuts.
  - JetBrains Mono is **only** for IDs, commits, hashes, file paths, code and chat tool steps.
  - Times, durations, sizes and counts use Inter with `tabular-nums`, including the chat meta lines.
  - This app is for non-technical users too.
- **Density:** comfortable. 14px body, 13px meta, 36–40px table rows, generous page margins.
- **Surfaces:** an open layout. Sections are a heading over content, separated by space and 1px hairlines.
  - Soft tinted surfaces (U-16's `soft-surface`) are only for live or actionable things: running work, needs-you, errors.
  - Empty sections collapse to one quiet line or disappear.
  - No border-plus-shadow cards.
- **Motion:** 150–250ms ease-out, no bounce. Subtle View Transitions between pages: a crossfade, and a row's title morphs into the detail title. All of it is off under reduced motion, and all of it is CSS only (CSP).

## Patterns

- **Entity chips everywhere.** Agents, tasks, chats, runs, files, triggers, integrations and members render as chips:
  - A type icon or the agent's avatar, the name, an optional status dot.
  - Hovering opens the same hovercard as in chat; clicking opens the entity.
  - The chip core and the hovercard move into `@ptbk/ui` as generic parts (icon or avatar, label, tint, status, hovercard body slot). Entity-specific chips stay in `apps/engine-ui` (`features/entities/`), reusing U-16's agent and task chips.
  - Underlined links remain only in prose and for external URLs.
- **Agents look the same everywhere:** coloured avatar and colour, in lists, the palette, headers and hovercards.
- **Tables:** table-like rich rows, in the spirit of Twenty CRM, not an old CRM.
  - Column headers have icons and sort on click. Rows are hairlines, with chips and avatars in cells and actions on hover. Group headers where state matters (Now, Coming up, Done).
  - Above the table sits a Twenty-style filter bar: a search, "+ Filter" adding removable filter chips (Status: running ×, Agent: (A) Ada ×), and Sort. State lives in the URL. There are no saved views.
  - On mobile, the same rows collapse to two-line items, not key/value cards.
- **Controls:** one consistent Select, combobox and date control replace native `<select>` mixed with custom dropdowns.
- **Shell:** a quiet sidebar (smaller labels, muted icons, a subtle selected state instead of a fill, counts in tabular figures). Each page gets a slim sticky header with breadcrumbs, the title and the primary action; "Back to …" links go.
- **Home is Chatter-first:**
  - an "Ask Chatter anything…" composer that starts a chat;
  - **Needs you:** questions from agents, failed work, login requests, on soft surfaces;
  - **Working now:** live steps and running tasks;
  - **Recent chats.**

  The activity feed moves out of the main column.

- **Empty states:** one calm line, one action and a small monochrome icon.

## Phases

1. **Foundations + three screens.**
   - Tokens, type, buttons, badges and status, sections, inputs and selects, the entity chip and hovercard core, the table and filter bar, the shell and page header, and View Transitions.
   - Applied to Home, the Tasks list and Task detail.
   - Seb reviews the screenshots (light, dark, mobile) before anything merges.
2. **Roll out.** Parallel lanes restyle every other engine-ui screen with the same parts.
3. **Dashboard.** app.ptbk.io's screens: sign-up, engines, billing, account.

Each phase merges only after Seb's screenshot OK.

## Rules

- Strict CSP: no inline style strings. Dynamic colour only goes through the CSSOM `--tint`.
- Untrusted text renders as text nodes.
- WCAG 2.2 AA in both themes: contrast is tested and colour is never the only signal.
- Reduced motion is respected.
- i18n in en and cs.
- No new runtime dependencies without need.
- Bundle budgets are raised only with recorded reasons.
- `docs/design/ui.md` gains a "Visual identity" section that records the above.

## Acceptance criteria

- [ ] Phase 1: the gallery shows every new part. Home, Tasks and Task detail match this brief in light, dark and mobile. Seb approved the screenshots.
- [ ] Phase 2: no underlined entity links remain in the engine UI. Every list uses the shared table and filter bar.
- [ ] Phase 3: the dashboard uses the same identity.
- [ ] lint, typecheck, tests, `test:csp` and e2e `ui` pass. axe passes in both themes.
