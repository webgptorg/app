# UI product brief

**Promptbook lets a company run its own AI agents on its own server and use them through one polished web app, while we provide the connectivity, the dashboard and the UI without ever being able to read their data.**

This brief describes how the engine UI and the dashboard should work and feel. Architecture is in [ADR 0015](../adr/0015-ui-architecture-and-design-system.md) and [ADR 0016](../adr/0016-engine-capabilities.md). The visual pass (Anka) comes later and builds on the tokens; this document fixes structure, behaviour and character, not final pixels.

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

- **Sidebar** with the engine switcher at the top, sections grouped (work: Home, Agents, Chats, Runs; resources: Files, Triggers, Integrations; admin: Members, Security, Settings). Collapses to icons; becomes a drawer on mobile.
- **Engine switcher, Stripe-style:** the engine's name and trust mark top-left open a menu. The full list of your engines lives in the dashboard (the engine UI may only talk to its own engine), so the menu shows the current engine plus "All engines" and "Add engine", which open the dashboard's switcher; picking an engine there navigates to its own hostname (its own origin and sign-in; synced passkeys make it quick).
- **Command palette (⌘K):** jump to any agent, chat, run or setting; actions like "New agent", "Stop run".
- **Trust mark** in the shell (see below), user menu (language, theme, sign out), and a quiet live indicator when runs are active.

## Key screens

- **Home (owner/admin):** greeting; at-a-glance counts (agents, running now, needs attention); recent agents; live activity feed (runs started and finished, files produced, triggers fired, member changes, update available); quick action "New agent". **Home (member):** my agents, recent chats, my running work.
- **Agents list:** `DataTable` with search, filters (status, folder, visibility), sort, and live status; cards on mobile.
- **Agent overview:** identity (avatar, name, description), live status, recent runs, triggers, integrations, knowledge at a glance; primary actions Chat, Run, Edit, Stop.
- **Create agent:** the guided wizard from the predecessor, refined: _Brief_ (describe the job in plain words) → _Book_ (AI draft, editable) → _Knowledge_ (drop files) → _Test_ (chat with the draft) → _Publish_. One click switches to the pro editor at any step.
- **Book editor (pro):** CodeMirror with the book language, diagnostics, version history and diff, and a live test chat beside it.
- **Chat:** streaming replies, visible progress card and tool calls while the agent works, stop, attachments, safe markdown; model output never becomes an executable control.
- **Runs:** timeline across agents and per agent: source (chat, email, schedule, API, member, goal), status, steps, tool calls, usage and cost, errors, outputs (messages, files, project changes with changed files). Cancel and retry where permitted.
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
