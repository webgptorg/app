# C-11. Onboarding contract additions: registration codes and the engine fingerprint

- **Lane:** Contracts · **Module:** `packages/protocol` (plus the callers named below) · **Milestone:** M3
- **Depends on:** C-03, U-02, E-05
- **Status:** in progress (feat/c-11-onboarding-contract-additions)
- **Spec:** Interfaces (draft) 1; Pairing and identity (First setup); design: [onboarding.md](../../design/onboarding.md), [ui.md](../../design/ui.md) (Trust mark); guide: [installation.md](../../engine-integration/installation.md)

## Goal

Two additive contract changes the onboarding flow needs: the registration error codes the dashboard already answers are in `REGISTRATION_ERROR_CODE`, and the engine fingerprint derivation lives in the open `@ptbk/protocol`, so the engine's terminal and its open setup page can show the same code the dashboard and the engine UI show.

## Context

The dashboard answers 403 `not-entitled` and 429 `rate-limited` at registration (D-03), but `REGISTRATION_ERROR_CODE` lists neither, so the mock engine treats both as `unavailable` and the guide carries an open point. Decided 2026-10-26 (E-05): onboarding needs no engine contract change beyond these additive pieces.

The fingerprint (`ptbk-fingerprint-v1`: SHA-256 over the prefix and the engine ID, a 20-character Crockford base32 code and a 5×5 pattern) is derived in `packages/ui` (`components/trust-mark/fingerprint.ts`, pinned by `fingerprint-vectors.json`). `packages/ui` is private and imports no contract package, so the open engine cannot use it. Onboarding asks the person to compare the fingerprint in the terminal with the dashboard's, which only works if the engine derives it from the same open code.

## Scope

- `REGISTRATION_ERROR_CODE` gains `not-entitled` (403) and `rate-limited` (429). Additive: a reader that does not know them still treats an unknown code tolerantly. Update the problem tests and the C-03 statuses table.
- `@ptbk/protocol` gains `deriveEngineFingerprint(engineId)` (code, formatted code, pattern bits, cells) and `FINGERPRINT_DERIVATION`, moved from `packages/ui` without changing a single output: `fingerprint-vectors.json` moves with it and must pass unchanged.
- `packages/ui` no longer derives: `TrustMark` takes the derived `EngineFingerprint` (or its code and cells) as a prop, and the dashboard and engine-ui call the protocol function. `packages/ui` keeps importing no contract package.
- `docs/engine-integration/`: the fingerprint export in identity-and-registration.md and checklist rows ENG-104 and the fingerprint line in installation.md's first-start output (remove "may omit it until …"); README open point 4 loses the two codes.

## Out of scope

- The mock engine printing the fingerprint and mapping the new codes (M-08). Heartbeat changes (decided: none).

## Design notes

- The move must be byte-for-byte: same prefix, same bit order, same alphabet. The vectors are the proof.
- If a cleaner split appears (for example `TrustMark` taking only `engineId` and an injected derive function), keep one derivation, in `@ptbk/protocol`, and say why in the PR.
- Touches `packages/ui`, `apps/dashboard` and `apps/engine-ui` call sites minimally; say so in the PR.

## Acceptance criteria

- [ ] `REGISTRATION_ERROR_CODE` includes `not-entitled` and `rate-limited`; problem tests cover both; the dashboard's registration tests still pass unchanged.
- [ ] `deriveEngineFingerprint` is exported from `@ptbk/protocol`, covered at the package's coverage thresholds, and every case in the moved `fingerprint-vectors.json` passes.
- [ ] No fingerprint derivation remains in `packages/ui`; D-06's fingerprint tests and engine-ui's security page tests pass with the same codes.
- [ ] The guide's checks pass; the open points no longer list these items.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The fingerprint becomes part of the public contract and freezes with it (E-02): changing the derivation later means `ptbk-fingerprint-v2` beside v1.
