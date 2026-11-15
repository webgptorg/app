# UI product brief

**Promptbook lets a company run its own AI agents on its own server and use them through one polished web app, while we provide the connectivity, the dashboard and the UI without ever being able to read their data.**

This brief describes how the engine UI and the dashboard should work and feel. Architecture is in [ADR 0015](../adr/0015-ui-architecture-and-design-system.md) and [ADR 0016](../adr/0016-engine-capabilities.md). The visual identity below (U-17) is the first visual pass; it lives in the tokens, so later passes change the theme, not feature code.

## Principles

1. **Calm control.** Owners see everything their agents do and can stop anything in one or two steps. Nothing important is hidden behind settings.
2. **Trust you can feel, not read.** Security is visible as craft and a distinctive mark, not as warnings and padlocks.
3. **Fast and quiet.** Instant navigation (prefetch on intent), optimistic where safe, no spinners where a skeleton fits, no layout shift.
4. **Personal and polished.** The Promptbook identity, warm copy, purposeful motion; it should feel like a product people enjoy showing.
5. **Grows without clutter.** Features appear when the engine supports them and the member may use them ([ADR 0016](../adr/0016-engine-capabilities.md)).

## People and permissions

- **Owner and admins** run the engine: agents, members, security, settings.
- **Members** create and use agents within their permissions; **viewers** observe.
- The UI renders by permission, never by role name ([ADR 0006](../adr/0006-organizations-and-roles.md)). In v0 there is one owner; the structure is ready for teams.

## Information architecture

```
Engine UI (<engineId>.<engine domain>)
├── Home            role-aware: control center for owners/admins, "my agents and chats" for members
├── Agents          list → agent detail
│   └── Agent       Overview · Chat · Runs · Files · Triggers · Integrations · Book · Settings
├── Chats           all conversations the member can see
├── Runs            all agent work across agents (capability runs@1)
├── Files           knowledge and outputs (capability files@1)
├── Triggers        email, schedules, webhooks (capability triggers@1)
├── Integrations    tools, MCP servers, connectors (capability integrations@1)
├── Members         (members.read)
├── Security        what you verify and who gets in: trust panel, verification checklist, passkeys, sessions
└── Settings        what you change: update policy, language, theme
```

The agent detail tabs and the main sections come from the feature registry, so a capability the engine does not advertise simply does not appear.

## Shell

- **Sidebar** with the engine switcher at the top, sections grouped (work: Home, Agents, Chats, Tasks, Runs; resources: Files, Triggers, Integrations; admin: Members, Security, Settings). Collapses to icons; becomes a drawer on mobile.
- **Engine switcher, Stripe-style:** the engine's name and trust mark top-left open a menu. The full list of your engines lives in the dashboard (the engine UI may only talk to its own engine), so the menu shows the current engine plus "All engines" and "Add engine", which open the dashboard's switcher; picking an engine there navigates to its own hostname (its own origin and sign-in; synced passkeys make it quick).
- **Page header:** every screen has a slim header that stays in view on wide screens: breadcrumbs (Tasks › Ship billing v2) instead of "Back to …" links, the title and the primary action. A list row's title morphs into the detail page's title through a View Transition; route changes cross-fade. Both are off under reduced motion.
- **Command palette (⌘K):** jump to any agent, chat, run or setting; actions like "New agent", "Stop run".
- **Trust mark** (see below) in the engine switcher only; its menu opens with "Verify this engine" (the fingerprint code, then the trust panel). A language switch ("EN ▾") beside the engine switcher and in the phone top bar; the user menu (Settings, Security, theme, sign out); and a quiet live indicator when runs are active.

## Key screens

- **Home, Chatter-first, for every member:** a greeting and a large "Ask Chatter anything…" composer that starts a chat with Chatter and opens it; then **Needs you** (agents' questions quoted with Reply, tasks waiting on the member, and every feature's attention count, such as failed runs, login requests or people asking to join, each with one action, on soft surfaces); **Working now** (agents replying with their latest step and a timer, running tasks, runs that belong to neither); **Recent chats** (agent avatars, title, preview, time). Members who oversee the engine also get the update notice and the live activity feed, in a quiet side column on wide screens and after everything else on narrow ones. Empty sections are one quiet line.
- **Agents list:** `DataTable` with search, filters (status, folder, visibility), sort, and live status; two-line rows on mobile.
- **Agent overview:** identity (avatar, name, description), live status, recent runs, triggers, integrations, knowledge at a glance; primary actions Chat, Run, Edit, Stop.
- **Create agent:** the guided wizard from the predecessor, refined: _Brief_ (describe the job in plain words) → _Book_ (AI draft, editable) → _Knowledge_ (drop files) → _Test_ (chat with the draft) → _Publish_. One click switches to the pro editor at any step.
- **Book editor (pro):** CodeMirror with the book language, diagnostics, version history and diff, and a live test chat beside it.
- **Chat:** streaming replies, visible progress card and tool calls while the agent works, stop, attachments, safe markdown; model output never becomes an executable control.
- **Tasks** (`tasks@1`): the engine's task inventory as the engine models it, read-only and in the engine's order, sectioned into now, coming up and finished; filters by status group, agent and kind; system work muted. A task's detail shows its state and why, conditions, parent and subtasks, what it depends on and blocks, directed links to chats and agents, origin, notes and its occurrence history (work cycles, recurring slots, reopenings, retries) with their runs. No task buttons: a quiet "Discuss in chat" opens the task's conversation, because work changes through Chatter.
- **Runs:** the run history: one run is one attempt at a task occurrence or a chat reply, so it links back to its task. Timeline across agents and per agent: source (chat, email, schedule, API, member, goal), status, steps, tool calls, usage and cost, errors, outputs (messages, files, project changes with changed files). Cancel and retry where permitted.
- **Files:** knowledge per agent and files produced by agents, scan status, versions where available.
- **Triggers:** inbound email addresses, schedules (once, interval, cron with next/last fire), webhooks later; fire history linked to runs; pause and resume.
- **Integrations:** what each agent may use (MCP servers, calendar, repositories…), status and scopes, the secrets they reference by name, recent activity.
- **Security:** what you verify and who gets in, for every member. The trust panel (engine identity and fingerprint), then a short checklist that opens into the details: UI bundle version and hash, TLS certificate and CT status, relays and tunnel state, hostnames, outbound destinations, exact last heartbeat payload (all with `security.read`); then access: sessions and passkeys (own, and others' with permission) and a pointer to the audit log.
- **Settings:** what you change: the update policy (with `security.read`, editable with `settings.manage`), language and theme.

## Trust mark

Not a generic padlock. A distinctive Promptbook seal: a custom SVG mark, quietly present in the shell, with a short calm animation when the engine verifies (like the sense of sealed, end-to-end security in Signal or WhatsApp). Opening it shows "Private engine: your data stays on your server" and the trust panel.

It carries an **engine fingerprint**: a visual pattern and a short code derived from the engine ID, also shown in the dashboard, the engine's terminal and its setup page for the same engine (one derivation, `deriveEngineFingerprint` in `@ptbk/protocol`). Users can compare them across devices the way Signal users compare safety numbers. A different fingerprint means a different engine. Rendered from the engine ID only, deterministic, accessible (code readable by screen readers).

## Dashboard (app.ptbk.io)

Same design system, simpler: sign-up and sign-in with passkeys, engines list with live status and fingerprints, add engine (link code and install command), billing (Stripe), account. It links into engines; it never shows engine content.

## Visual identity

Visual identity v1 ([U-17](../plan/tasks/U-17-visual-identity.md), decided with Seb on 2026-11-13) is **calm precision**: Linear-style, readable for technical and non-technical people alike. The tokens live in `packages/ui/src/theme/` and the gallery's "Visual identity" entry shows them at a glance.

### Colour

- **Graphite chrome.** Neutrals are the `--ptbk-graphite-*` scale. The page is `--color-surface`; panels and popovers are `--color-raised`. Hover and selection are quiet washes of the text colour, not fills: `--color-hover` (5%) and `--color-selected` (8%). They read the same on any surface.
- **No inverted fills.** Buttons are soft (see Parts); nothing is a near-black slab in light or a near-white one in dark. `--color-primary` (graphite) is left for small marks that need weight: a checked box, a switch that is on, a tab's indicator. The older `--color-accent*` names resolve to it, so nothing built on them turns teal.
- **Colour comes from agents and status.**
  - Agents: `--color-agent-1..8`, or the agent's profile colour.
  - Status: `--color-success`, `--color-warning`, `--color-danger` and `--color-info`, each with a quiet `-soft` fill. `--color-live` marks running work.
- **Teal has three jobs:** `--color-focus` (focus rings), `--color-link` (links in prose) and `--color-selection` (selected text). Nothing else is teal.
- **Dark mode is calm, never loud.** There is no bright cyan. Neutral pills sit on `--color-neutral-soft`, never on a black slab. Status fills are a trace of their hue over graphite.
- **Lines.** `--color-hairline` separates sections and rows. `--color-divider` is a stronger separator. `--color-border` is only for control boundaries (inputs, checkboxes), at 3:1.
- **Contrast.** Every text pair is AA (4.5:1) and every graphic pair 3:1, in both themes. `packages/ui/test/contrast.test.ts` enforces this, including the washes composited over the page.

### Type

- **Inter everywhere.** Outfit is gone, and `font-display` is Inter too.
- **Headings** (h1–h4) use `--heading-weight` (600) and tighter tracking (`--tracking-heading`, and `--tracking-display` for h1).
- **Comfortable density:**
  - 14px body (`text-sm`, the `body` default);
  - 13px meta (`text-xs`);
  - 12px (`text-2xs`) only for counts, badges and tiny labels.
- **Numbers that change:** times, durations, sizes and counts use Inter with `tabular-nums`. The `meta` utility (13px, muted, tabular) is the default for meta lines, chat ones included.
- **`font-mono` is deliberate and rare:** IDs, commits and hashes, file paths, code, and chat tool steps. Nothing else is mono: no times, dates, durations, counts, statuses or names. The app is for non-technical people too, and mono reads as "this is for engineers".

### Surfaces and layout

- **An open layout.** A `Section` is a heading over content, separated from its neighbours by space and a hairline. There are no border-plus-shadow cards; `Card` remains as a quiet hairline panel until its users move to `Section`.
- **Soft surfaces** (`soft-surface` with `--tint`) are only for live or actionable things: running work, needs-you, errors.
- **Empty sections** collapse to one quiet line (`EmptyState variant="inline"`) or disappear. A whole empty view gets one calm line, one action and a small monochrome icon.
- **What floats lifts.** Menus, popovers, hovercards and dialogs keep a soft `--shadow-overlay` over a hairline border. Radii are `--radius-control` (6px), `--radius-surface` (10px) and `--radius-small` (4px).

### Parts

- **`EntityChip`** is the core of every entity reference: an icon or `Avatar`, the name, an optional status dot, a `--tint`, and the shared hovercard.
  - Agents use `tone="agent"`: the name is in the agent's colour.
  - Every other entity uses `neutral`: text colour, with the hue only in the wash.
  - Entity-specific chips compose it in `apps/engine-ui/src/features/entities/`.
- **`Avatar`** puts the agent's initial on a wash of its colour, so an agent looks the same everywhere.
- **`StatusPill` and `StatusDot`** cover the tones `live`, `waiting`, `success`, `warning`, `danger`, `info` and `neutral`. The state is always in words, and the hue lives in the dot and the wash.
- **`Combobox`** replaces native `<select>` as screens move to it. `DateInput` is the native date control, styled: it is accessible, follows the browser's locale for date order, and opens the platform picker on phones.
- **Buttons are soft:** a text-coloured label on a quiet wash or a hairline.
  - `primary`, the main action, stands out only by a slightly stronger wash (`--color-wash-strong`), medium weight and its place.
  - `secondary` is the hairline without the wash; `ghost` has neither.
  - `danger` is a soft red wash (`--color-danger-wash`) with red text; `danger-ghost` is red text alone.
  - Hover and press deepen the wash (`-hover`, `-active`).
  - `danger-solid`, a deep red fill (`--color-danger-fill`), is the one filled button: only the confirm dialog's destructive action (see Patterns).
- **Inputs** (`Input`, `Textarea`, `Select`, `Combobox`, `DateInput` and the filter bar's search boxes) all have a 1px border at 3:1, so a field is findable without its label. Focus turns it teal with a soft halo that hugs the field (`--input-ring`).
- **`PeekCard`** is the hovercard body for every entity, Linear-style:
  - a header with the icon or avatar, the type in small text ("Task") and a `StatusPill`;
  - the name, large and semibold, with one quiet line under it;
  - two to four facts (label → value, values may be chips);
  - behind a hairline, the "Open …" action with an ↵ hint. Enter anywhere in the card opens it.

  It sits on a soft wash of the agent's or the state's colour, about 320px wide.

### Motion

- **Timing:** state changes take 150–250ms, ease-out, with no bounce.
- **Route changes:**
  - The page crossfades (`--motion-page`).
  - An element named the same on both pages morphs into its new place (`--motion-morph`), e.g. a list row's title into the detail page's title. Name elements with `viewTransitionStyle(scope, id)`, which goes through the CSSOM, so the CSP holds.
- **Reduced motion:** all of it is off under `prefers-reduced-motion`.

## Patterns

- **Destructive actions** (Delete, Revoke, Remove…) live in the object's "More" (⋯) `ActionMenu`, after a separator, as red-text items; never as a filled red button beside the primary actions. Filled red appears only in the confirm dialog that names the object. The same holds for page headers, drawers and the phone sticky action bar.

## Responsive

Works from 360 px. Mobile-first for chat, agent status, runs and their actions, and notifications; desktop-optimised but usable for the Book editor and wide tables (which become cards).

## Motion

Short, meaningful, interruptible: new activity slides in, completed runs settle, live items breathe subtly, route changes use View Transitions, the trust mark seals. Duration and easing come from tokens. `prefers-reduced-motion` turns motion into simple fades or none.

## Copy and language

English and Czech from day one. Plain, warm, specific ("Lead bot is drafting replies to 3 emails"), no jargon in member-facing screens; precise terms in Security.

- **Toasts** echo the verb in the past tense: `<Name> <verb>.` ("Weekly report paused.", 'Run "Daily digest" stopped.'). A failure says what could not happen ('"Weekly report" could not be paused.'). The tone follows the outcome: a check that finds a problem is a warning, never a success.
- **Runs are stopped**, never cancelled: the button, the status ("Stopping…", "Stopped") and the toast use the same verb as the agent's Stop.
- **Values nobody reported** are a muted dash with "Not reported" for screen readers, never "Unknown", which reads like an error.
- **Names, not IDs**: link a trigger, file or run by its name; IDs and hashes go behind a details disclosure.

## Accessibility

WCAG 2.2 AA: keyboard everywhere, visible focus, labels, contrast in both themes, live regions for streaming and activity, no information by colour alone.
