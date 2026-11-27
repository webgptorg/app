# C-20. Owner setup handoff: contract and conformance

- **Lane:** C · **Module:** `packages/protocol`, `packages/conformance` · **Milestone:** M5
- **Depends on:** C-08, C-15
- **Status:** in progress (feat/c-20-owner-handoff-contract)
- **Spec:** Pairing and identity; ADRs: [0023](../../adr/0023-owner-setup-handoff.md), [0010](../../adr/0010-protocol-design-principles.md), [0014](../../adr/0014-cryptography.md)

## Goal

The two contract fields of ADR 0023, and platform checks that prove an engine takes the pairing tab's setup secret as a second setup slot, signals when the tab may redirect, and never lets that slot outlive its owner, its expiry or its support.

## Scope

- `packages/protocol`: `RegisterEngineResponse.ownerSetupCommitment` (canonical base64url of 32 bytes, nullable, default `null`) and the heartbeat's optional `ownerHandoff: "ready"` in v1 and v2. `OwnerSetupSecret`, `newOwnerSetupSecret`, `ownerSetupCommitment` (`base64url(SHA-256(UTF-8 of S))`, an independent vector), `OWNER_HANDOFF_LIFETIME_MS`.
- Both fields are additions in the same version: no protocol version and no `ENGINE_API_VERSION` bump (it stays 1.15.0).
- `packages/conformance`: the fake dashboard hands a commitment out with a link code; an `owner-handoff` platform suite through a fake relay:
  - the signal arrives soon after the engine serves browsers, without waiting a heartbeat interval;
  - `/setup/options` and `/setup/verify` accept `S`; a wrong `S` gets the same answer as a wrong setup secret;
  - the first owner passkey spends both slots and ends the signal;
  - an engine registered without a commitment never sends the signal (an old dashboard);
  - an engine that does not support handoff skips the suite instead of failing it.

## Out of scope

- The mock engine's slot and signal (M-15) and the dashboard (D-39).
- Expiry in black-box conformance: an engine's clock cannot be moved from outside, so the 30 minutes are proven in the mock engine's unit tests.

## Acceptance criteria

- [ ] Strict in, tolerant out for both fields; refusal tests for wrong lengths, padding, standard base64 and unknown signal values.
- [ ] `protocol` coverage thresholds of 90% hold.
- [ ] Each owner-handoff check fails against a fake that breaks its rule, and skips against an engine without support.
- [ ] **Status** line above set to `done (#<PR>)`.
