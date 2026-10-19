# 0008. Hono for every HTTP API; contracts stay framework-agnostic

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

We serve HTTP APIs in two runtimes: the dashboard on Cloudflare Workers (its own UI API, the engine API `/v1`, the relay API `/internal`, Stripe webhooks) and the mock engine on Node. The real engine's API is built by the engine team; the spec allowed Hono or Fastify. The relay speaks raw TCP and TLS.

## Decision

- **Hono** for every HTTP API in this repo: the dashboard Worker and the mock engine. We recommend it to the engine team for the real engine, so mock and real share a framework.
- **Contracts stay framework-agnostic.** `protocol` and `engine-api` define zod schemas and route tables; each app binds them to Hono. The OpenAPI document is generated from the contracts, not from Hono.
- Each Hono app validates every request with the contract's zod schema before a handler runs, and answers errors as RFC 9457 problem+json.
- The dashboard's SPA calls its own `/api/*` through a typed client over the same schemas.
- **The relay uses no HTTP framework**: `node:net`, `node:tls` and `ws`. Its only HTTP surface, on its own hostname, is the tunnel upgrade, a health check and an authenticated metrics endpoint (task I-04); less code there is less attack surface.

## Consequences

- One way to write, validate and test an endpoint across Workers and Node. Hono runs on both natively.
- Swapping Hono later means rewriting bindings, not contracts.
- The engine team is free to pick another framework; the conformance suite, not the framework, decides compatibility.
