// Captures a TLS ClientHello as a fixture for the SNI parser (packages/protocol/src/tls).
//
//   node scripts/capture-client-hello.ts <name> --client "<client and version>" [--port 8443]
//
// Listens on 127.0.0.1, takes the first connection, writes its ClientHello records to
// packages/protocol/src/tls/fixtures/<name>.ts as base64 and exits. The client then fails its
// handshake, which is expected. `*.localhost` resolves to loopback in Chromium, Firefox, curl and
// Go, so those fixtures ask for `engine.localhost`; Playwright's WebKit does not resolve it, so its
// fixture asks for `localhost`. ClientHellos hold only random values and public key shares; never
// point a client with a stored session for a real account at this script.
//
// How the committed fixtures were captured (port 8443):
//
//   chromium, firefox, webkit  Playwright 1.64.0's bundled browsers, run ad hoc outside the repo:
//                              `npx playwright@1.64.0 install chromium firefox webkit`, then per
//                              browser `(await <browser>.launch()).newPage({ ignoreHTTPSErrors:
//                              true })` and `goto('https://engine.localhost:8443/')` (WebKit:
//                              `https://localhost:8443/`).
//   curl                       curl https://engine.localhost:8443/
//   openssl-servername         openssl s_client -connect 127.0.0.1:8443 -servername engine.localhost
//   openssl-noservername       openssl s_client -connect 127.0.0.1:8443 -noservername
//   node                       node -e "require('node:tls').connect({ host: '127.0.0.1', port: 8443,
//                              servername: 'engine.localhost' }).on('error', () => {})"
//   go-acme-tls                A Go program dialling like Pebble's TLS-ALPN-01 validator:
//                              tls.Dial("tcp", "127.0.0.1:8443", &tls.Config{ServerName:
//                              "engine.localhost", NextProtos: []string{"acme-tls/1"},
//                              InsecureSkipVerify: true})
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'packages', 'protocol', 'src', 'tls', 'fixtures');
const MAX_CAPTURE_BYTES = 64 * 1024;
const CAPTURE_TIMEOUT_MS = 5000;

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        client: { type: 'string' },
        port: { type: 'string', default: '8443' },
    },
});
const name = positionals[0];
if (name === undefined || !/^[a-z0-9-]+$/.test(name) || values.client === undefined) {
    console.error('usage: node scripts/capture-client-hello.ts <name> --client "<client and version>" [--port 8443]');
    process.exit(1);
}
const fixturePath = join(FIXTURES_DIR, `${name}.ts`);
const fixtureHeader = `// ${values.client}. Captured by scripts/capture-client-hello.ts.\n`;

/** End of the record that completes the first handshake message, if it has arrived. */
function clientHelloEnd(bytes: Uint8Array): number | undefined {
    let offset = 0;
    let handshake: number[] = [];
    while (offset + 5 <= bytes.length) {
        const recordEnd = offset + 5 + (((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0));
        if (recordEnd > bytes.length) return undefined;
        handshake = handshake.concat(Array.from(bytes.subarray(offset + 5, recordEnd)));
        const needed = 4 + (((handshake[1] ?? 0) << 16) | ((handshake[2] ?? 0) << 8) | (handshake[3] ?? 0));
        if (handshake.length >= 4 && handshake.length >= needed) return recordEnd;
        offset = recordEnd;
    }
    return undefined;
}

function writeFixture(bytes: Uint8Array): void {
    const source = `${fixtureHeader}export const clientHello =\n    '${Buffer.from(bytes).toString('base64')}';\n`;
    writeFileSync(fixturePath, source);
    console.log(`wrote ${String(bytes.length)} bytes to ${fixturePath}`);
}

let captured = false;
const server = createServer((socket) => {
    let received = new Uint8Array(0);
    const finish = (bytes: Uint8Array): void => {
        if (captured) return;
        captured = true;
        writeFixture(bytes);
        socket.destroy();
        server.close();
    };
    socket.setTimeout(CAPTURE_TIMEOUT_MS, () => {
        console.warn('timed out before a complete ClientHello; writing what arrived');
        finish(received);
    });
    socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        const end = clientHelloEnd(received);
        if (end !== undefined) finish(received.subarray(0, end));
        else if (received.length >= MAX_CAPTURE_BYTES) finish(received);
    });
    socket.on('error', () => undefined);
});
server.maxConnections = 1;
server.listen(Number(values.port), '127.0.0.1', () => {
    console.log(`waiting for one TLS connection on 127.0.0.1:${values.port}`);
});
