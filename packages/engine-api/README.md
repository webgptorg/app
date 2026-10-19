# @ptbk/engine-api

The engine HTTP API that engine-ui consumes and every engine implements: zod schemas (strict, versioned), the `EngineApiClient` interface with a `fetch` implementation, and the OpenAPI document generated from the schemas.

MIT, Web APIs only, no imports from `@ptbk/*`, so it can move to the public repo unchanged ([ADR 0002](../../docs/adr/0002-public-private-split.md)). Plan: task C-04.
