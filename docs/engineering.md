# Engineering guide

How code in this repo is structured. The goal: every module can be replaced by another implementation of the same interface without touching the rest. The mock engine and the real engine are the first case of that, not the last.

## Modules

A module is a workspace package under `apps/` or `packages/`.

- **It owns a contract.** Packages expose exactly one code entry (`"exports": { ".": "./src/index.ts" }`); deep imports are impossible. The one exception is `@ptbk/ui`, whose single entry also carries its stylesheet through the `style` condition (`".": { "style": "./src/theme.css", "default": "./src/index.ts" }`), so CSS `@import '@ptbk/ui'` and TypeScript resolve the same entry. Apps expose nothing in code; their contract is the network interface they serve.
- **It declares what it uses.** The isolated linker makes undeclared transitive dependencies fail to resolve. Root dev tools stay visible to every package by directory lookup, so declare what you import anyway. Workspace dependencies use `"workspace:*"`; shared third-party versions come from the root `catalog`.
- **Apps never import from apps.** They talk over the documented HTTP and tunnel interfaces only.
- **Contracts live in packages.** `protocol` (engine, relay, dashboard wire formats) and `engine-api` (engine HTTP API for the UI) are portable: no `node:*`, `cloudflare:*` or `bun:*` imports, Web APIs only (ESLint enforces it).

```mermaid
flowchart TD
    relay --> protocol
    dashboard --> protocol
    mock-engine --> protocol
    mock-engine --> engine-api
    engine-ui --> engine-api
    engine-ui --> ui
    dashboard --> ui
    conformance --> protocol
    conformance --> engine-api
```

## Contracts

Wire formats follow [ADR 0010](adr/0010-protocol-design-principles.md): versioned messages, negotiation in the handshake, change by addition, domain-separated signatures, canonical encodings, explicit limits. Formats freeze when the contracts are published (task E-02), after review by the engine team and Pavol.

## Inside an app: ports and adapters

```
src/
  domain/     Pure logic, types and ports (interfaces). No I/O, no node:, no cloudflare:.
  adapters/   Implementations of ports: node:net, D1, Stripe, fetch, in-memory fakes.
  app/        Composition root: parse config, build adapters, inject them, start.
  main.ts     (or worker.ts) Entry point; calls app/.
```

- `domain/` may not import `adapters/`, `app/` or platform modules (ESLint enforces it). It defines what it needs as an interface:

  ```ts
  export interface EngineRegistry {
    lookup(engineId: EngineId, signal: AbortSignal): Promise<RegistryLookup>;
  }
  ```

- Adapters implement ports. Every port gets an in-memory adapter too, used by unit tests and local development.
- Dependencies are passed in explicitly, as a `deps` object to a factory function or constructor. No DI container, no module-level singletons, no hidden global state.
- Configuration is parsed once in `app/` with zod into a typed, frozen object. Nothing else reads `process.env` or Workers bindings.
- Time, randomness and crypto are ports (`Clock`, `Random`, `Signer`) so tests are deterministic. The production `Random` uses `crypto.getRandomValues`; seeded fakes are refused outside tests.

engine-ui follows the same idea in React terms: components depend on hooks, hooks depend on an `EngineApiClient` interface from `engine-api`, and the composition root decides whether that client talks HTTP or an in-memory fake.

## TypeScript rules

- **Strict everything** (see `tsconfig.base.json`), including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **Erasable syntax only:** no `enum`, `namespace` or parameter properties. Use `as const` objects and string-literal unions.
- **Interfaces for object shapes and ports** (`consistent-type-definitions`); type aliases for unions and mapped types. No `I` prefix.
- **Branded types for identifiers and validated values:** `EngineId`, `Hostname`, `RelayId`, `StreamId`. They are created only by a zod schema or a parsing function: parse, don't validate.
- **`unknown` at boundaries, never `any`.** Every byte from the network, disk, env or another module goes through a zod schema first. Schemas are strict: unknown fields are rejected.
- **Discriminated unions** for states and outcomes, handled with exhaustive `switch` (`switch-exhaustiveness-check`).
- **`readonly` by default** for data passed between layers.
- **Named exports only.** Default exports are allowed only where a framework requires them (config files, Workers entry, route files).

## Errors

- Expected outcomes are values: return a discriminated union specific to the operation (`{ kind: 'routed', engineId } | { kind: 'unknown-host' }`). Callers must handle every case.
- Exceptions are for bugs and broken infrastructure. Catch them at the edge (request handler, connection handler), log without content, and fail closed.
- No generic `Result` library: a union named for the operation reads better.

## Request handling (every HTTP endpoint)

Security comes from construction, not from remembering. Every route is declared through one typed helper per app, and the router refuses to mount anything else:

```ts
defineRoute({
  method: 'POST',
  path: '/v1/engines/register',
  auth: 'engine-signature', // 'public' | 'session' | 'relay-token' | 'engine-signature' | 'stripe-signature'
  permission: null, // or a permission from the closed union; required when auth is 'session'
  input: { params, query, headers, body }, // zod schemas, strict; body size cap
  output: RegisterEngineResponse, // responses are validated in tests
  rateLimit: 'registration', // named policy; required for every non-session route
  handler,
});
```

- **Validate everything that comes in:** path params, query, headers that matter, body, cookies. Strict zod schemas (unknown fields rejected), length and size limits on every string, array and body, branded types after parsing. Handlers never see unparsed input. Signed bodies are verified over the exact bytes before parsing.
- **Authentication is mandatory and explicit.** `auth` has no default. `public` routes are an explicit allowlist checked by a test (sign-in, sign-up, recovery requests, health). Everything else requires a session, a relay token, an engine signature or a webhook signature, verified before the handler runs.
- **Authorization is allowlisted.** Roles and permissions are closed unions; a role or permission not in the list fails to parse (from the database too). The role-to-permission mapping lives in one policy module per app. `Authorizer.can()` runs for every session route, deny by default, and checks ownership for self-scoped routes; resources the actor may not see answer 404, not 403, so IDs cannot be probed.
- **Fail closed and quietly.** Errors are problem+json with stable codes and no internals (no stack traces, SQL, or upstream messages). Unexpected exceptions become 500 with a correlation ID; details go to logs without content or secrets.
- **Defence in depth on the edge:** CSRF via Fetch Metadata and Origin for cookie-authenticated mutations, no CORS (same origin only), strict security headers, cookies `__Host-`, `Secure`, `HttpOnly`, rate limits on every anonymous or machine endpoint.
- **A route-table test** enumerates every mounted route and fails if one lacks an input schema, an `auth` mode, a permission for session routes, or a rate limit for non-session routes, or if a `public` route is not on the allowlist.

The relay applies the same rules to its non-HTTP input: every ClientHello, frame and handshake message is size-bounded and parsed by the protocol package before anything acts on it.

## Authorization

- One policy port per app, `Authorizer.can(actor, action, resource)`, deny by default ([ADR 0006](adr/0006-organizations-and-roles.md)).
- Code checks permissions, never role names. Adding a role must not touch handlers or components.
- Every data access in the dashboard is scoped by `orgId`; a query without it is a bug.

## Async and I/O

- Every I/O call has a timeout and accepts an `AbortSignal`.
- Long-lived connections (tunnels, streams) have explicit backpressure: respect `write()` returning `false`, use `WINDOW` credit in the tunnel protocol.
- Prefer Web Streams and `fetch` in portable code; Node streams only in Node adapters.

## Testing

| Level         | What                                                      | Where                    |
| ------------- | --------------------------------------------------------- | ------------------------ |
| Unit          | Domain logic with in-memory adapters (fakes, not mocks)   | `src/**/*.test.ts`       |
| Property/fuzz | Parsers and codecs: SNI parser, frame codec, schemas      | next to the code         |
| Adapter       | One shared test suite per port, run against every adapter | `src/adapters/*.test.ts` |
| Conformance   | The engine contract, run against mock or real engine      | `packages/conformance`   |
| End to end    | Browser through relay to engine, failover, proxies        | `e2e/` (Playwright)      |

- Tests are deterministic: inject `Clock` and `Random`, seed fake data, no sleeps (use fake timers or events).
- A bug fix starts with a failing test.
- **Where tests live:** unit and adapter tests sit next to the code they test (`foo.ts` and `foo.test.ts`; property tests as `foo.property.test.ts`), so a module carries its tests when it moves and gaps are visible in review. Cross-module integration tests of an app (its HTTP app with real adapters wired) live in `apps/<app>/test/`. Browser and multi-process flows live in `e2e/`, the engine contract in `packages/conformance`. Shared fixtures go in a `fixtures/` folder next to their tests; reusable fakes and test helpers in `src/testing/`. Bundlers only include what entry points import, and coverage and builds exclude `*.test.ts`, so tests never ship.
- A module with code has no `--passWithNoTests`. Contract packages and security-relevant code keep coverage thresholds of at least 90% lines and branches (`@vitest/coverage-v8`).

## Logging and metadata

- Structured logs through a `Logger` port. Never log content, tokens, keys, cookies or full headers.
- The relay logs only what the spec's "Metadata we still see" lists, and keeps it short-lived.

## Naming

- Files and directories: `kebab-case.ts`. Types and interfaces: `PascalCase`. Functions and variables: `camelCase`. Constants that are configuration: `SCREAMING_SNAKE_CASE`.
- One concept per file; name the file after it.
- No barrel files inside apps. A package has one `src/index.ts` that is its public API.
