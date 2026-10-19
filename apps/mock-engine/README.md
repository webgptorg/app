# @ptbk/mock-engine

A stand-in for the real engine that speaks every real contract: it registers with the dashboard, dials the relays, serves TLS inside the tunnel, sends signed heartbeats, runs the UI loader and serves the engine API with seeded fake data ([ADR 0004](../../docs/adr/0004-mock-engine-and-conformance.md)).

- The same seed gives the same data; state is in memory and reacts to mutations.
- Scenarios (empty engine, small team, large fleet) and fault injection (latency, errors, dropped streams) are set at startup or through a dev-only control endpoint.
- No shortcuts the real engine would not have: everything goes through the contracts. That makes it the reference implementation for the engine team, and the conformance suite keeps it honest.

Plan: tasks M-01 to M-06. Not scaffolded yet.
