# <ID>. <Title>

- **Lane:** <lane> · **Module:** `<path>` · **Milestone:** <M#>
- **Depends on:** <IDs or —>
- **Status:** todo
- **Spec:** <section names in docs/spec/zero-trust-spec.md>; ADRs: <links if relevant>

## Goal

One or two sentences: what exists after this task that did not before.

## Context

What the agent needs to know that is not obvious from the spec: why this matters, how it fits with neighbouring tasks.

## Scope

- Concrete deliverables: files, ports, adapters, schemas, endpoints.

## Out of scope

- What belongs to another task (name it).

## Design notes

Ports and types to introduce, file layout, library choices with versions, edge cases. Follow [engineering.md](../../engineering.md).

## Acceptance criteria

- [ ] Verifiable statements: tests that exist and pass, behaviour observable in e2e, docs updated.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Anything the agent should flag instead of deciding alone.
