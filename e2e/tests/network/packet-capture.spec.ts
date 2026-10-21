import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComposeControl } from '../../src/compose.ts';
import { expect, test } from '../../src/fixtures.ts';
import { analyseCapture } from '../../src/pcap/analyse-capture.ts';
import { launchPreferringRelay } from '../../src/relay-order.ts';
import { CAPTURE_MOUNT, HTTPS_PORT, RELAYS, RELAY_A_CAPTURE_FILE } from '../../src/stack.ts';

const SNIFFER = 'relay-a-sniffer';
const CAPTURE = join(CAPTURE_MOUNT, RELAY_A_CAPTURE_FILE);
const SSE_EVENTS = 5;

const LISTENING = /tcpdump: listening on /g;

async function captureStarts(compose: ComposeControl): Promise<number> {
    return (await compose.logs(SNIFFER)).match(LISTENING)?.length ?? 0;
}

/*
 * Everything the browser does here crosses relay-a in the capture: the page (with its per-run canary), an SSE stream
 * and a WebSocket exchange carrying the canary. The relay pipes those bytes without decrypting them, so the capture
 * must hold only TLS records for the engine hostname and none of that plaintext. On failure the capture is attached:
 * it holds only this test's traffic on port 443, and no TLS key log exists anywhere in the stack.
 */
test('relay-a carries only TLS records for the engine, never its plaintext', async ({
    playwright,
    compose,
    engineHost,
    spikeUrl,
}, testInfo) => {
    test.setTimeout(120_000);
    const relayA = RELAYS[0];
    if (relayA === undefined) throw new Error('the stack has no relay');

    await compose.stop(SNIFFER);
    const earlierStarts = await captureStarts(compose);
    await compose.start(SNIFFER);
    // tcpdump says so once its capture is live; anything before that would be missed.
    await expect.poll(() => captureStarts(compose), { intervals: [100], timeout: 30_000 }).toBe(earlierStarts + 1);

    const browser = await launchPreferringRelay(playwright.chromium, engineHost, relayA);
    let canary: string;
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const response = await page.goto(spikeUrl);
        expect(response?.status()).toBe(200);
        expect((await response?.serverAddr())?.ipAddress, 'the page came through relay-a').toBe(relayA.ip);
        canary = (await page.locator('#canary').textContent()) ?? '';
        expect(canary).toMatch(/^[0-9a-f]{32}$/);

        const exchanged = await page.evaluate(
            async ({ count, message }) => {
                const events = await new Promise<number>((resolve, reject) => {
                    let received = 0;
                    const source = new EventSource(`/__spike/sse?count=${String(count)}&intervalMs=20`);
                    source.onmessage = () => {
                        received++;
                        if (received === count) {
                            source.close();
                            resolve(received);
                        }
                    };
                    source.onerror = () => {
                        if (source.readyState === EventSource.CLOSED) reject(new Error('the event stream failed'));
                    };
                });
                const echo = await new Promise<string>((resolve, reject) => {
                    const socket = new WebSocket(`wss://${location.host}/__spike/ws`);
                    socket.onopen = () => {
                        socket.send(message);
                    };
                    socket.onmessage = (event: MessageEvent<string>) => {
                        socket.close();
                        resolve(event.data);
                    };
                    socket.onerror = () => {
                        reject(new Error('the WebSocket failed'));
                    };
                });
                return { events, echo };
            },
            { count: SSE_EVENTS, message: `canary ${canary}` },
        );
        expect(exchanged).toEqual({ events: SSE_EVENTS, echo: `canary ${canary}` });
        // Closing sends the TLS close_notify alerts; the capture has settled once the file stops growing.
        await context.close();
        let lastSize = -1;
        await expect
            .poll(
                async () => {
                    const size = (await stat(CAPTURE)).size;
                    const settled = size === lastSize;
                    lastSize = size;
                    return settled;
                },
                { intervals: [500], timeout: 30_000 },
            )
            .toBe(true);
    } finally {
        await browser.close();
        // SIGTERM: tcpdump writes what it holds and closes the file.
        await compose.stop(SNIFFER);
    }

    const capture = await readFile(CAPTURE);
    try {
        const analysis = analyseCapture(capture, {
            serverPort: HTTPS_PORT,
            engineHostname: engineHost,
            forbiddenPlaintext: [canary, 'HTTP/1.1', 'GET /', 'data: {', 'id: 1\n', '/__spike/'],
        });
        console.log(
            `packet capture: ${String(capture.length)} bytes, ${String(analysis.connections.length)} connections, ` +
                `${String(analysis.engineConnections)} to the engine hostname`,
        );
        expect(analysis.engineConnections, 'browser connections to the engine in the capture').toBeGreaterThan(0);
        expect(analysis.problems).toEqual([]);
        expect(analysis.plaintextHits).toEqual([]);
    } catch (error) {
        await testInfo.attach(RELAY_A_CAPTURE_FILE, { body: capture, contentType: 'application/vnd.tcpdump.pcap' });
        throw error;
    }
});
