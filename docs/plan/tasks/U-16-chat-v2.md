# U-16. Chat v2: live steps, references, tasks and a modern thread

- **Lane:** U · **Module:** `apps/engine-ui`, `packages/ui` · **Milestone:** M5
- **Depends on:** C-14
- **Status:** todo
- **Spec:** Security hardening (5 agent output is untrusted, 6 tool calls never become code); ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md)

## Goal

The chat is the product's main surface and should feel like it. Who is speaking, what agents are doing, which tasks they started and what went wrong are all visible natively, in a calm, modern thread. Decided with Seb on 2026-11-13.

## Look

- Agent replies stay plain, readable text under a coloured avatar and name. The member's own messages stay a bubble on the right.
- Events sit on **soft surfaces**: a faint wash of the agent's colour (about 5%), no border, no shadow, 14px radius and a small status dot. Events are steps, tasks, errors and questions to the User. No old-school cards. The chat may look more modern than the rest of the UI.
- **Agent colour**: the profile colour if set, else a stable hash into a curated 8-hue palette that works in light and dark.
- **Motion**: Linear-style, 150–250ms ease-out, no bounce, all off under reduced motion. A sent message glides up from the composer. Replies and cards fade in and rise 6px. Streamed text fades in. Steps slide in, and card height animates on collapse. Status dots pulse slowly.
- **Mono** (JetBrains Mono, bundled): tool steps, IDs, commits, paths and meta lines (`12:16 · 8s · 3 steps`, timers).
- **Scrollbar**: thin, over the content, visible on hover or scroll (Grok-like). CSS only.
- **Times**: a mono time next to the author on each turn, the exact time on hover, and day dividers.
- **Composer**: the growing one-line box, floating on a soft surface over the thread, with the thread fading out beneath it. Send turns into Stop.

## Behaviour

- **Steps**: while an agent works (`Chat.working`), a live card ticks through its steps (reasoning, tool name plus argument, notes) with an elapsed timer, starting the moment the turn starts. Once the `final` reply exists, the turn's `progress` messages collapse to one line above the reply, "Worked 8s · 3 steps ›", which expands. Progress without a final reply stays expanded and is marked unfinished.
- **Interim parsing**: against an engine that sends no `phase` (pre-C-14), a completed agent message whose every line is `- thinking: …` or `- <Tool> <args>`, followed by another message from the same author, is read as progress. It lives in one small module, removed when the engine ships C-14 (delete by E-03).
- **References**: one shared core, a chip plus a hovercard, for `@Agent` and `{Task name}` in message text. Tasks look distinct from agents.
  - Agent hovercard: avatar, name, one-line role, what it is doing in this thread now (its working step or running task), and two actions, Open agent and Mention.
  - Task hovercard: state, agent, detail, timer and commit, with Open task.
  - Unknown names stay plain text. Hovercards open after about 300ms or on keyboard focus.
- **Mentions**:
  - `+@User` becomes an "asks you" highlight on the message, with its choices.
  - `@` in the composer autocompletes the thread's members and the project's agents.
  - Clicking an agent chip addresses it: a "to @Name ×" chip appears in the composer, and the message goes out as `+@Name …`.
- **Task card**: at a `linked` entry, a soft surface shows the status dot and state, the name, the agent chip, one live line (`detail`) and a timer (`startedAt`/`endedAt`). When completed, it adds the commit and Open task. It updates on `chat.changed`.
- **No response**, escalating quietly:
  - right after Send: "Chatter is starting…";
  - after 20s without `working` or text: "Still waiting for Chatter";
  - after 2 min: an error card, "Chatter didn't respond", with Retry and details.
  - A `recheck` shows its cause and "Retrying automatically in 1:40 · Retry now" (`POST /chats/{chatId}/retry`).

## Security

Every reference, step and task text is untrusted and rendered as text nodes. A tool step is never a link or a control except the card's own expand toggle. The reference parser works on markdown AST text nodes, never on HTML. No inline styles, so agent colours go through the CSSOM or classes (strict CSP).

## Delivery

Two PRs, both `Refs: U-16`:

- **A**: the reference core, agent colours, mentions and autocomplete, composer, scrollbar, motion, mono and times.
- **B**: thread content, which covers steps, task cards, errors and the interim parser.

Seb reviews screenshots and a GIF of the demo-seed thread before merge.

## Acceptance criteria

- [ ] The demo-seed copywriter thread renders as described: steps live, then collapsed; the task card; Copywriter's message with its `{task}` chip; and `@` chips in each agent's colour.
- [ ] The no-response and recheck states show and recover; Retry calls the route.
- [ ] Against a pre-C-14 response (no new fields), the same thread still shows its steps through the interim parser.
- [ ] Hostile-output tests cover references, steps and task text. axe passes. Reduced motion disables the animation. `test:csp` passes.
