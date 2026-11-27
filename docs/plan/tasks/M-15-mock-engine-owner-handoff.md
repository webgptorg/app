# M-15. Mock engine: the owner setup handoff slot

- **Lane:** M · **Module:** `apps/mock-engine` · **Milestone:** M5
- **Depends on:** C-20, M-10
- **Status:** todo
- **Spec:** Pairing and identity; ADR [0023](../../adr/0023-owner-setup-handoff.md)

## Goal

The reference engine accepts the pairing tab's commitment as a second, one-time setup slot and tells the dashboard when the tab may send the owner to the setup page.

## Scope

- Registration keeps `ownerSetupCommitment` as a second slot (digest, expiry 30 minutes from registration) in the setup secret store, unless the engine has an owner or runs with handoff off (`PTBK_OWNER_HANDOFF=off`, and off by default in strict mode).
- `/setup/options` and `/setup/verify` accept either slot; the first owner passkey spends both. `setup-link` replaces only the engine's own slot; `owner --reset` drops the handoff slot.
- Heartbeat `ownerHandoff: "ready"` while the slot is live, the engine has no owner and its address serves browsers; a heartbeat is sent as soon as that turns on.
- The setup's audit entry and terminal line say when the owner came through the handoff; with a live slot the engine does not open its own link on the desktop, but still prints it.

## Acceptance criteria

- [ ] Unit tests: a wrong `S`, an expired slot, a slot on an engine that already has an owner, handoff off, both slots spent by one setup, `setup-link` and `owner --reset`.
- [ ] The `owner-handoff` conformance suite passes against the mock engine.
- [ ] **Status** line above set to `done (#<PR>)`.
