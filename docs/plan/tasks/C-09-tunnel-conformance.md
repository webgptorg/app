# C-09. Tunnel conformance suite: a fake relay the engine dials

- **Lane:** Contracts · **Module:** `packages/conformance` · **Milestone:** M5
- **Depends on:** C-02, C-05, M-01, M-02
- **Status:** in progress (feat/c-09-tunnel-conformance)
- **Spec:** Interfaces (draft) 3. Tunnel protocol, Relay and tunnel; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0010](../../adr/0010-protocol-design-principles.md), [0014](../../adr/0014-cryptography.md)

## Goal

The `tunnel` suite acts as a relay that the engine dials and checks the engine's tunnel client against C-02's contract: handshake signing, negotiation, reject and close handling, reconnects, frames, flow control and TLS through a stream.

(Brief in progress; the full scope follows in this PR.)
