# U-19. Import website logins from password managers

- **Lane:** Engine UI · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-06
- **Status:** in progress (feat/engine-ui-wallet-import)
- **Spec:** [zero-trust spec](../../spec/zero-trust-spec.md), Security hardening item 7; ADR 0016

## Goal

Import selected website logins from a Bitwarden plaintext JSON or CSV export, or a compatible CSV export from another password manager, into the engine's Wallet.

## Scope

- Local, bounded file parsing; preview names, sites and usernames without passwords.
- Bitwarden JSON and CSV; CSV columns used by 1Password, LastPass and Chromium browsers.
- Require `wallet.manage` and a ready Wallet. Skip existing origin/username pairs by default and require an explicit choice to replace them.
- Sequential writes through the existing write-only Wallet save API and its passkey step-up; report partial completion and stop on failure.
- Keep imported passwords out of React state, caches, storage, logs, URLs and error messages; clear pending secrets on close and unmount.
- English and Czech copy, parser and UI regression tests, and a browser scenario.

## Acceptance criteria

- [ ] Preview and selection work for supported exports; unsupported records and malformed/encrypted files are explained.
- [ ] Existing logins are preserved by default; passwords and unsupported extra fields are never rendered or persisted in the client.
- [ ] Partial failures, cancellation and step-up are covered without replaying completed writes.
- [ ] Scoped lint, formatting, typecheck, build/bundle budgets and tests with coverage pass.
- [ ] Documentation and browser coverage describe the new flow.

## Limits

This converts website logins to existing Wallet saves, not a full vault restore. Cards, notes, attachments, passkeys, OTP seeds and custom fields are not imported. Encrypted archives and 1PUX are not accepted. No engine API or new runtime dependency is needed.
