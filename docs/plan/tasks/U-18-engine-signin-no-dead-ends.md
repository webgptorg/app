# U-18. Engine sign-in: no dead ends without a passkey

- **Lane:** Engine UI · **Module:** `packages/gateway-pages` · **Milestone:** M3
- **Depends on:** M-08
- **Status:** in progress (fix/gateway-signin-no-dead-ends)
- **Spec:** [Teams](../../spec/teams.md), [zero-trust spec](../../spec/zero-trust-spec.md) "More devices"

## Goal

People who reach the engine's sign-in page without a passkey for it on this device (a dashboard member who never finished joining, someone who typed the address, a member on a new device) see plain ways forward instead of an empty passkey sheet and "Try again".

## Scope

- Keep the explicit sign-in button; never open the passkey prompt on its own.
- Under it, a short "No passkey for this engine on this device?" section: a passkey on a phone, adding this device from one already signed in, and opening the engine from the Promptbook dashboard to join.
- The cancelled and failed states show the same ways forward prominently.
- English and Czech (formal), calm and short.
- No contract change; no outside origin the CSP or the rules forbid.

## Acceptance criteria

- [ ] Page and script tests cover the section in the ready, cancelled and failed states.
- [ ] Asset integrity tests still pass; CSP is unchanged.
- [ ] Copy in English and Czech.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.
