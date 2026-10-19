# Security

This repo carries the zero-trust guarantees of the Promptbook platform: the relay never decrypts engine traffic, and the dashboard stores no engine content. A bug that breaks either is a security issue, even if it looks like a functional bug.

**Reporting:** do not open an issue or a PR that describes the problem. Message the maintainers privately; they will confirm within two working days.

The security model is in [docs/spec/zero-trust-spec.md](docs/spec/zero-trust-spec.md) (sections Security goals and threat model, and Security hardening). Repo-level rules are in [docs/security.md](docs/security.md).
