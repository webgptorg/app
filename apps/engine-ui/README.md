# @ptbk/engine-ui

The full app for engine owners and members: agents, agent creation and editing, chat, security panel, secrets metadata, audit log.

It is built into a hashed static bundle with a manifest, signed and logged as part of a release. The engine downloads it on update, verifies it and serves it from its own origin; we never serve it to browsers ([ADR 0003](../../docs/adr/0003-ui-as-signed-bundle.md)). It therefore runs under the engine's strict CSP (no inline code, no `eval`, no external origins, Trusted Types) and talks only to the engine API through `EngineApiClient` from `@ptbk/engine-api`.

Sign-in and setup are not here: they belong to the open engine gateway, and this UI loads only after authentication.

Plan: tasks U-01 to U-07. Not scaffolded yet.
