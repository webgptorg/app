# M-02. TLS and HTTP server inside the tunnel, dev CA, spike endpoints

- **Lane:** Mock engine · **Module:** `apps/mock-engine` · **Milestone:** M1
- **Depends on:** M-01
- **Status:** todo
- **Spec:** Relay and tunnel; Build plan (Spike acceptance criteria); Operations (Bandwidth and cost); Engine security baseline; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0014](../../adr/0014-cryptography.md)

## Goal

Browser TLS ends inside the mock engine: each tunnel stream gets a TLS server with a certificate for the engine's hostname, an HTTP server behind it, and the endpoints the spike needs to prove pages, SSE, WebSockets and bulk throughput work through the relay.

## Context

This is the engine half of the passthrough: the relay pipes bytes (R-04), the mock engine terminates TLS with a key only it holds. For M1 the certificate comes from a local dev CA; M-03 adds ACME TLS-ALPN-01 behind the same port. M-04 and M-05 mount the engine API and the UI on the HTTP app created here.

## Scope

- `src/domain/tls/certificate-source.ts`: port `CertificateSource { current(hostname: Hostname): TlsCredentials | undefined; onChange(listener): () => void }` where `TlsCredentials` holds PEM certificate chain and key.
- `src/adapters/dev-ca.ts` (with `@peculiar/x509@2.1.0`, exact, on Node's WebCrypto; ADR 0014): `createDevCa(permittedDomains)` returns an ECDSA P-256 CA whose certificate is constrained so a leaked dev CA cannot vouch for real sites: a critical name constraints extension permitting only the dev engine domain and test domains (`PTBK_ENGINE_DOMAIN` plus the e2e domains from config) and excluding all IP addresses, `basicConstraints` CA with `pathLen 0`, key usage `keyCertSign` and `cRLSign` only. `issueLeaf(ca, hostnames, clock)` returns a short-lived (7-day) leaf with SANs, key usage `digitalSignature` and EKU `serverAuth`; `DevCaCertificateSource` re-issues it before expiry and emits `onChange`. `DevCaCertificateSource` uses CA files from `MOCK_DEV_CA_CERT_FILE` and `MOCK_DEV_CA_KEY_FILE` when set (X-01 generates them so Playwright and curl can trust the CA before the engine starts), otherwise generates a CA into `PTBK_DATA_DIR/dev-ca/` (0600). Tests generate everything in memory. No mkcert, no committed keys.
- Name constraints construction: `@peculiar/x509@2.1.0` has no `NameConstraints` class, so build the extension with `@peculiar/asn1-x509@2.10.0` and `@peculiar/asn1-schema@2.10.0` (exact, from the workspace catalog): `new x509.Extension('2.5.29.30', true, AsnConvert.serialize(new NameConstraints({ permittedSubtrees: new GeneralSubtrees(domains.map((d) => new GeneralSubtree({ base: new GeneralName({ dNSName: d }) }))), excludedSubtrees: new GeneralSubtrees([ipv4Any, ipv6Any]) })))`, where `ipv4Any` and `ipv6Any` are `GeneralSubtree`s whose `iPAddress` is `0.0.0.0/0` and `::/0` (RFC 5280 §4.2.1.10: address plus mask, 8 and 32 zero octets). If the library's `IpConverter` does not accept CIDR strings, build those two `GeneralName`s from raw octets; the test asserts the DER either way. The extension is critical (second argument `true`).
- `src/adapters/tls-stream-server.ts`: one `tls.Server` (TLS 1.3 minimum, ALPN `http/1.1`, plus `h2` if added below) fed by `server.emit('connection', duplex)` for each tunnel stream from M-01. Certificates are chosen per SNI through `SNICallback` from the `CertificateSource`, so a renewal (M-03) applies to new connections without restart. Unknown SNI: handshake fails.
- `src/adapters/http/http-app.ts`: a Hono 4.13.x app served through `@hono/node-server` 1.x (`getRequestListener`) on a `node:http` server fed by `httpServer.emit('connection', tlsSocket)`. WebSocket upgrades go through the HTTP server's `upgrade` event to `ws` (`noServer: true`) with a small route table.
- `src/adapters/http/spike-routes.ts`, all under `/__spike/`:
  - `GET /__spike/` static HTML page (no inline script or style) naming the engine ID; `GET /` serves the same page until M-05 mounts the UI.
  - `GET /__spike/whoami`: JSON `{ engineId, hostname, clientIp, alpn, tlsVersion }`, where `clientIp` comes from the tunnel's `OPEN` frame, to prove the relay passes it.
  - `GET /__spike/sse?count=N&intervalMs=M`: server-sent events with an incrementing ID; honours `Last-Event-ID`.
  - `WS /__spike/ws`: echo, text and binary, up to 1 MB per message.
  - `WS /__spike/screencast?fps=F&bytes=B`: pushes binary frames of `B` bytes at `F` fps, each starting with a sequence number and send timestamp (X-02 and R-05 measure fps, latency and GB per hour with it).
  - `GET /__spike/download?bytes=N`: streams `N` bytes (cap 1 GiB) with `Content-Length`, respecting backpressure.
- Wire into `start-mock-engine.ts`: tunnel streams → TLS server → HTTP app. Engine hostname = `<engineId>.<PTBK_ENGINE_DOMAIN>`, plus any hostnames the relay confirmed in `ready`.

## Out of scope

- ACME (M-03). Engine API and gateway session (M-04). UI loader and the full security headers (M-05). Playwright tests through a browser (X-01).

## Design notes

- HTTP/2: try `http2.createSecureServer({ allowHTTP1: true })` in place of the `tls.Server` + `http.Server` pair only if SSE, the WebSocket upgrade over HTTP/1.1 and the download all still pass. If anything is awkward, ship HTTP/1.1 and note h2 as follow-up.
- Every endpoint has limits (`count`, `fps`, `bytes` validated by zod, unknown query params rejected) so the spike routes cannot become an amplification tool.
- Spike responses send `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; the full header set is M-05's.
- Destroy the TLS socket when the tunnel stream closes, and vice versa; no leaked handles after a test.

## Acceptance criteria

- [ ] Dev CA tests: the leaf verifies against the CA, SANs match, validity (7 days) uses the injected clock and the source re-issues before expiry, keys are never printed; the CA certificate carries the name constraints as a critical extension (DER decoded in the test: permitted DNS subtrees as configured, excluded `0.0.0.0/0` and `::/0`), `pathLen 0` and only `keyCertSign`/`cRLSign`; a leaf the CA issues for a name outside the permitted domains fails `tls.connect` verification, and so does a leaf whose SAN is an IP address (`127.0.0.1`), connected to by IP.
- [ ] In-process test without a relay: a pair of linked duplexes stands in for a tunnel stream; `tls.connect` with the dev CA trusted and the engine SNI gets `GET /__spike/whoami` with the injected client IP; a wrong SNI fails the handshake.
- [ ] Tests for SSE (N events, reconnect with `Last-Event-ID`), WebSocket echo (text, binary, 1 MB), screencast (requested fps within 10 % over 5 s using fake time where possible), download (exact byte count, backpressure: memory stays bounded with a paused reader).
- [ ] Invalid query params return 400; values over caps return 400.
- [ ] Integration test with R-04's relay in process (once merged): `curl`-equivalent `node:https` request to `https://<engineId>.<domain>/__spike/whoami` through the relay succeeds.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- `server.emit('connection', duplex)` on `tls.Server` with a non-socket duplex is common but lightly documented; if a Node version breaks it, fall back to `new tls.TLSSocket(duplex, { isServer: true, ... })`.
- Whether X-01 trusts the dev CA in Playwright via launch flags or a browser profile is X-01's choice; this task only makes the CA available as files.
