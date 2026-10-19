# R-01. SNI parser for the TLS ClientHello

- **Lane:** Relay · **Module:** `packages/protocol` (`src/tls/`) · **Milestone:** M1
- **Depends on:** —
- **Status:** todo
- **Spec:** Relay and tunnel; Interfaces (draft) 3 "Browser side"; Metadata we still see; ADRs: [0005](../../adr/0005-modular-architecture.md)

## Goal

A pure, fuzzed function that reads the first bytes of a browser connection and says which hostname it asked for, without ever terminating or altering TLS.

## Context

Every browser connection to the relay starts with a TLS ClientHello. The relay buffers it, reads the `server_name` extension and routes the still-encrypted bytes (R-04). This parser is the only code that touches bytes from anonymous clients before routing, so it must never throw, never read out of bounds and never buffer without limit. It knows nothing about engines, sockets or the registry.

It lives in `packages/protocol`, not in the relay, because the mock engine (M-03) and the real engine need the same parser to spot `acme-tls/1` on incoming tunnel streams, and apps never import apps. It must stay portable (no `node:*`), like the rest of the package.

## Scope

- `packages/protocol/src/tls/client-hello.ts`: `parseClientHello(bytes: Uint8Array, options: { maxBytes: number }): ClientHelloParse`.
- `packages/protocol/src/tls/client-hello-buffer.ts`: a small accumulator (`createClientHelloBuffer({ maxBytes })` with `push(chunk): ClientHelloParse` and `bytes(): Uint8Array`) that concatenates chunks and re-parses; it is what R-04 uses. Still pure: no timers, no I/O.
- Unit tests, property tests (fast-check 4.x as a dev dependency of `@ptbk/protocol`) and fixtures under `packages/protocol/src/tls/fixtures/`: one TypeScript module per capture exporting the bytes as a base64 string, decoded to `Uint8Array` by a small helper (`atob`, portable), so tests need no `node:fs` and run anywhere. Export `parseClientHello`, `createClientHelloBuffer` and the `ClientHelloParse` type from the package entry.
- `scripts/capture-client-hello.ts` at the repo root (the root `tsconfig.json` already includes `scripts` with Node types, so it may use `node:net` and `node:fs`): a dev script that listens on a local port, writes the first bytes of each connection as a fixture module and closes. Its header documents how each fixture was captured, including the ad hoc ones the developer runs by hand (Playwright browsers, a Go `crypto/tls` or Pebble client); no new dev dependencies.

## Out of scope

- Sockets, timeouts, routing, hostname branding (`Hostname` from C-01 is applied by R-04).
- Encrypted Client Hello: the outer SNI is what we route on; no ECH decryption ever.

## Design notes

- Outcome union, exhaustive at call sites:
  ```ts
  type ClientHelloParse =
    | { readonly kind: 'need-more' }
    | { readonly kind: 'sni'; readonly hostname: string; readonly alpn: readonly string[] }
    | { readonly kind: 'no-sni'; readonly alpn: readonly string[] }
    | { readonly kind: 'malformed'; readonly reason: MalformedReason }
    | { readonly kind: 'too-large' };
  ```
  `MalformedReason` is a string-literal union (`'not-handshake' | 'unsupported-record-version' | 'not-client-hello' | 'length-mismatch' | 'bad-extensions' | 'duplicate-extension' | 'bad-server-name'`). No `enum`.
- Parse TLS records (type 0x16, legacy version 0x0301–0x0303; anything else in the first byte, including an SSLv2-style hello, is `not-handshake`), then reassemble the handshake message across records (legal, and seen with large post-quantum key shares), then walk the ClientHello: version, random, session ID, cipher suites, compression, extensions.
- `server_name` (type 0): exactly one `host_name` entry, 1–253 bytes, ASCII letters, digits, `-` and `.` only, no empty labels, no trailing dot. Return it lowercased. Anything else is `bad-server-name`.
- `alpn` (type 16): return the offered protocol names. ALPN is returned only so a TLS server peeking at a stream can spot `acme-tls/1` (M-03). The relay must never route or log on it: an ACME validation connection is routed exactly like a browser.
- `too-large` as soon as a declared record or handshake length shows the ClientHello cannot complete within `maxBytes` (R-04 passes 16 KiB), and when the buffer reaches `maxBytes` without a complete ClientHello. A complete ClientHello of exactly `maxBytes` bytes parses normally. `need-more` only while a valid prefix is still incomplete and can still fit. Bytes after the ClientHello are ignored.
- Implement with `DataView` and explicit bounds checks; no `Buffer`, no `node:*` imports, no dependencies. No imports from the rest of the package except C-01 primitives if useful.
- Commits use the `protocol` scope (the module is `packages/protocol`), e.g. `feat(protocol): parse SNI from the TLS ClientHello`.

## Acceptance criteria

- [ ] Fixtures from Chromium, Firefox and WebKit (captured ad hoc via Playwright), curl, `openssl s_client -servername` and `-noservername`, Node `tls.connect`, and a Go client offering only `acme-tls/1` (Pebble or `crypto/tls`) all parse to the expected outcome.
- [ ] Unit tests cover: SNI missing, empty name, two names, non-ASCII byte, trailing dot, uppercase input (lowercased), 254-byte name, duplicate extension, extension length past the end, ClientHello split across two records, an HTTP request (`GET /`) instead of TLS (`not-handshake`), an SSLv2-style hello (`not-handshake`), a ServerHello (`not-client-hello`).
- [ ] Property: for every fixture and every split into chunks, feeding the buffer chunk by chunk gives the same result as parsing in one go, and every strict prefix gives `need-more`.
- [ ] Property: arbitrary byte arrays (up to 20 KiB) and random byte flips of valid fixtures never throw and always return one of the five kinds.
- [ ] Property: a generated valid ClientHello (random hostname from an LDH arbitrary, random extension order, random padding) returns `sni` with that hostname.
- [ ] Inputs reaching `maxBytes` without a complete hello, and a first record or handshake header declaring a length past `maxBytes`, return `too-large`, never `need-more`; a complete hello of exactly `maxBytes` bytes parses.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Fixtures contain random values and public key shares only, never secrets. Do not capture against a server that uses session tickets from a real account.
