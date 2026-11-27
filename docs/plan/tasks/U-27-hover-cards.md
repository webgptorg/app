# U-27. Engine UI: one agent card everywhere

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M5
- **Depends on:** U-16, U-17
- **Status:** done (#380)
- **Spec:** —; ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md)

## Goal

Every place that names an agent opens the same agent card the entity chips open elsewhere in the app: in chat the author of a turn, the `@Agent` chips and the agent of a task card, and the few other places that named an agent without it.

## Context

The chat had its own agent hovercard (thread activity and Mention), while the thread's own participant chips, Home, Tasks and the other screens opened the shared `AgentCard`. Turn authors had no card at all. Seb asked for one behaviour everywhere.

## Scope

- `AgentCard` takes what a thread adds (`here`: working there now, a detail line, Mention), and `agentHovercard()` gives that card for any hovercard trigger.
- `AgentLink`: an agent in its own look (avatar and name) as a link to the agent with the shared card, for places a chip does not fit.
- Chat: turn author, `@Agent` chips and the agent chip of a task card open the shared card; the thread decides `canOpenAgents` like `canOpenTasks`.
- Home: the agent of a question in Needs you and of a reply in Working now.
- Runs table: the agent chip opens the agent's card like every other table.

## Out of scope

- A member card on the authors of members' messages, and agent names inside sentences (wallet requests, the waiting line). Listed as leftovers in the PR.

## Acceptance criteria

- [x] Hover and keyboard focus open the card after the shared delay, Esc closes it and returns focus, its accessible name is the agent's name, on the author of a turn, the `@Agent` chips and the task card's agent (`thread-references.test.tsx`).
- [x] Home's question and reply names link to the agent with the card (`home.test.tsx`).
- [x] engine-ui tests and the bundle budget pass.
- [x] **Status** line above set to `done (#<PR>)`.
