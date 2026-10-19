# 0003. The UI is a private, signed bundle that the engine serves

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

The full app UI must be private (commercial), the engine public, and the zero-trust guarantee unchanged. Whatever JavaScript runs on the engine's origin sees all decrypted data. Whoever chooses that JavaScript at page-load time can target one customer for a few minutes, undetected. That is the known weakness of end-to-end encryption on the web.

Options:

- **Serve the UI live from our servers.** Rejected: one deploy, or one compromised account or court order, reaches every customer's data instantly and invisibly.
- **B: the browser loads the bundle from our CDN, the engine pins its hash (SRI).** Rejected as default: the UI breaks when our CDN is down, we see metadata for every page load, and integrity for dynamically loaded chunks is new in browsers.
- **A: the engine downloads the bundle, verifies it, and serves it from its own origin.** Chosen.

## Decision

- engine-ui is built here into a static, hashed bundle with a manifest. CI signs it, logs it in Rekor and publishes it to R2 as part of a release (spec, Interfaces 5: an artifact with `"kind": "ui"`).
- On update, the engine's UI loader (public, about 100 lines) downloads the bundle, checks the same things as for engine releases (signature threshold, Rekor inclusion, delay passed, no revocation, hashes match the manifest), and serves it from its own origin.
- The security-enforcing parts stay in the open engine: pre-auth gateway, sign-in, setup and WebAuthn pages, CSP and Trusted Types headers, API authorization, audit. Anonymous visitors only ever get open code.
- Enterprise and offline installs can mirror the bundle.
- The mock engine implements the loader too, as the reference implementation for the engine team.

## Consequences

- The UI must work under the engine's strict CSP: no inline scripts or styles, no `eval`, no external origins, Trusted Types.
- The UI depends only on the engine API (`packages/engine-api`), never on our services.
- **Residual risk, stated publicly:** CSP cannot block every exfiltration path (top-level navigation, WebRTC), so against a deliberately malicious UI the protection is the release process, not CSP. Customers cannot rebuild the UI from source; we or an auditor under NDA verify rebuilds. Public wording: "the security layer is open and verifiable; the UI is closed but sandboxed, signed, logged and identical for everyone".
- Code secrecy is the same in every option: the browser always receives the minified bundle. "Private" means the source and the license.
- If a customer rejects a closed UI, switching to B or to a source-available license changes delivery, not the UI's code.
