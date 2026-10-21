# M-03. ACME TLS-ALPN-01 through the relay against Pebble

- **Lane:** Mock engine · **Module:** `apps/mock-engine`, plus `e2e/` compose services (touches two modules) · **Milestone:** M1
- **Depends on:** R-01, M-02, X-01
- **Status:** in progress (feat/m-03-acme)
- **Spec:** Residual risks: certificates and engine updates (1); Hosting and stack (Known hard problems, TypeScript stack "Certificates"); Build plan (Spike acceptance criteria); Relay and tunnel; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0014](../../adr/0014-cryptography.md)

## Goal

Prove or disprove the spec's riskiest assumption: the engine obtains its own certificate with ACME TLS-ALPN-01 while reachable only through the passthrough relay, with no DNS action from us. The mock engine gets an ACME `CertificateSource` that issues and renews against Pebble in the e2e stack.

## Context

The CA's validation server connects to `<engineId>.<domain>:443` with SNI set to that hostname and ALPN `acme-tls/1` only (RFC 8737). The relay routes it like any browser (R-04 never looks at ALPN), so the challenge reaches the engine through the tunnel. The engine must answer that one connection with a special self-signed certificate while normal browser traffic for the same hostname keeps getting the real one, which matters for renewals. If this fails, the fallback is DNS-01 through our DNS API, as Nabu Casa does it.

## Scope

- `src/domain/tls/alpn-dispatch.ts`: peeks at the first bytes of each tunnel stream with the ClientHello parser imported from `@ptbk/protocol` (R-01; SNI and ALPN, never a local parser) and decides `{ kind: 'acme-challenge'; hostname } | { kind: 'normal' } | { kind: 'reject' }`. ALPN offering exactly `acme-tls/1` with a pending challenge for that hostname goes to the responder; `acme-tls/1` with no pending challenge is rejected.
- `src/adapters/tls-alpn-responder.ts`: a `tls.Server` with `ALPNProtocols: ['acme-tls/1']` serving the challenge certificate from `acme.crypto.createAlpnCertificate(authz, keyAuthorization, key)`; peeked bytes are `unshift`ed back onto the duplex before handing it over.
- `src/adapters/acme-certificate-source.ts` (`acme-client@5.4.0`, exact; acceptable for this Pebble spike only, see open points): implements M-02's `CertificateSource`. Account key in `PTBK_DATA_DIR/acme/account-key.pem` (0600), created once. Issue flow: order for each engine hostname, choose the `tls-alpn-01` challenge, register it with the responder, `completeChallenge`, wait for valid, finalize with a CSR from a locally generated ECDSA P-256 key, store chain and key in `PTBK_DATA_DIR/tls/` (0600), emit `onChange`. Removes the challenge certificate as soon as the authorization settles.
- `src/domain/tls/renewal-policy.ts`: pure `renewalDue(cert, now)`: renew when less than a third of the lifetime remains; check every 12 h and at startup. Failures retry with backoff and keep serving the current certificate.
- Config: `MOCK_CERT_SOURCE` (`dev-ca` | `acme`), `PTBK_ACME_DIRECTORY_URL`, `PTBK_ACME_EMAIL` (optional). The ACME server's own TLS trust comes from `NODE_EXTRA_CA_CERTS` in compose (Pebble's minica); no global axios mutation in code.
- `e2e/`: add `letsencrypt/pebble` and `pebble-challtestsrv` (both pinned by image digest) to the compose stack. challtestsrv answers DNS for the engine domain with the relay's address; Pebble uses it (`-dnsserver`) and validates TLS-ALPN-01 on port 443 (`tlsPort: 443` in its config), with `PEBBLE_VA_NOSLEEP=1`. A short certificate validity in Pebble's config lets the renewal test run in minutes.
- Playwright test: the browser trusts only Pebble's root (fetched from Pebble's management endpoint at test start), opens `https://<engineId>.<domain>/__spike/whoami` through the relay, and the page loads with the ACME-issued certificate.
- `docs/spike/acme-tls-alpn-01.md`: result, the exact flow observed (relay logs show only a routed stream), timing, and the DNS-01 fallback design if anything failed.

## Out of scope

- CT monitoring and CAA records (engine team). Custom-domain certificates beyond reusing the same flow for every hostname in `ready`. The real Let's Encrypt staging run in CI (see open points).

## Design notes

- The relay is not changed by this task. If it has to be, that is a finding: stop and report it.
- Challenge certificates live only in memory and only while the authorization is pending.
- Log ACME events (`acme.order-created`, `acme.challenge-valid`, `acme.certificate-issued` with notAfter); never log keys, key authorizations or account URLs with tokens.
- DNS-01 fallback (document only unless TLS-ALPN-01 fails): the engine asks the dashboard, with an engine-signed request, to set `_acme-challenge.<hostname>` TXT; the dashboard accepts only the engine's own hostnames. Note that this needs DNS access by us for every issuance, which weakens the "no DNS action from us" property in Residual risks.

## Acceptance criteria

- [ ] Unit tests: `alpn-dispatch` for ACME with pending challenge, ACME without, normal browser hello, malformed; `renewal-policy` at 10 %, 50 % and 90 % of lifetime; the responder offers only `acme-tls/1` and the challenge certificate contains the `acmeIdentifier` extension (verify with acme-client's `isAlpnCertificateAuthorizationValid` if available).
- [ ] E2E: a fresh mock engine with `MOCK_CERT_SOURCE=acme` obtains a Pebble certificate through the relay, and a browser loads `/__spike/whoami` with it.
- [ ] E2E renewal: with short Pebble validity, the engine renews while a browser holds an open SSE stream; the stream survives and new connections get the new certificate.
- [ ] E2E: an `acme-tls/1` connection for the engine hostname with no pending challenge is closed, and normal traffic is unaffected.
- [ ] A packet capture or relay log check shows the relay only routed streams (no TLS termination for the engine hostname).
- [ ] `docs/spike/acme-tls-alpn-01.md` records the outcome.
- [ ] `bun run check` and the e2e suite pass.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The ClientHello parser comes from `@ptbk/protocol` (R-01). Do not copy or fork it; if it lacks something, extend it there.
- The spike criterion names a Let's Encrypt **staging** certificate. CI uses Pebble only. A real staging run needs a public relay and public DNS, so it is a manual run after I-01 and I-02 land: write the runbook in the spike doc now and record the result then. Until that run passes, the spike criterion stays open. Let's Encrypt validates from several vantage points, which may hit different relays: the engine must hold tunnels to every relay DNS returns, and relay per-IP limits must not throttle validators.
- `acme-client` has been unmaintained since 2024 (ADR 0014). It is fine for proving the flow against Pebble, but the engine team chooses the production ACME client (open point); keep it behind `CertificateSource` so the swap touches one adapter.
- Let's Encrypt is moving to shorter certificate lifetimes and ARI; the renewal policy should accept an ARI hint later without redesign.
