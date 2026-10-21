import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComposeControl } from '../../src/compose.ts';
import { expect, test } from '../../src/fixtures.ts';
import { analyseCapture } from '../../src/pcap/analyse-capture.ts';
import { eventsAfter, serviceEvents } from '../../src/service-events.ts';
import { CAPTURE_MOUNT, HTTPS_PORT, PEBBLE, PEBBLE_VALIDITY_S, RELAY_A_CAPTURE_FILE } from '../../src/stack.ts';

const SNIFFER = 'relay-a-sniffer';
const CAPTURE = join(CAPTURE_MOUNT, RELAY_A_CAPTURE_FILE);
const LISTENING = /tcpdump: listening on /g;

async function captureStarts(compose: ComposeControl): Promise<number> {
    return (await compose.logs(SNIFFER)).match(LISTENING)?.length ?? 0;
}

/*
 * The validation connection crosses relay-a like any other: a capture of relay-a's port 443 during a renewal holds
 * Pebble's connection as TLS records end to end in both directions, starting with a ClientHello for the engine
 * hostname offering only acme-tls/1. Relay-a never terminates it (it logs nothing about the engine hostname at all),
 * and only the engine could complete it: the challenge certificate exists nowhere but in the engine's memory.
 */
test('relay-a only routes the TLS-ALPN-01 validation: TLS records both ways, nothing terminated', async ({
    compose,
    engineHost,
}, testInfo) => {
    test.setTimeout(240_000);
    await compose.stop(SNIFFER);
    const earlierStarts = await captureStarts(compose);
    await compose.start(SNIFFER);
    await expect.poll(() => captureStarts(compose), { intervals: [100], timeout: 30_000 }).toBe(earlierStarts + 1);
    const capturingSinceMs = Date.now();

    try {
        await expect
            .poll(
                async () =>
                    eventsAfter(
                        await serviceEvents(compose, 'mock-engine'),
                        'acme.certificate-issued',
                        capturingSinceMs,
                    ).length,
                { intervals: [1_000], timeout: (PEBBLE_VALIDITY_S + 60) * 1_000, message: 'a renewal ran' },
            )
            .toBeGreaterThan(0);
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
        await compose.stop(SNIFFER);
    }

    const capture = await readFile(CAPTURE);
    try {
        const engineEvents = await serviceEvents(compose, 'mock-engine');
        expect(
            eventsAfter(engineEvents, 'acme.challenge-valid', capturingSinceMs, { hostname: engineHost }),
        ).not.toEqual([]);
        const analysis = analyseCapture(capture, {
            serverPort: HTTPS_PORT,
            engineHostname: engineHost,
            forbiddenPlaintext: [],
        });
        const validations = analysis.connections.filter((connection) => connection.client.address === PEBBLE.ip);
        expect(validations.length, "Pebble's validation crossed relay-a").toBeGreaterThan(0);
        for (const connection of validations) {
            expect(connection).toMatchObject({
                kind: 'engine',
                alpn: ['acme-tls/1'],
                clientToServerTls: { kind: 'tls' },
                serverToClientTls: { kind: 'tls' },
            });
            expect(analysis.problems.filter((problem) => problem.startsWith(connection.label))).toEqual([]);
        }

        const relayEvents = (await serviceEvents(compose, 'relay-a')).filter(
            (event) => event.timeMs >= capturingSinceMs,
        );
        expect(
            relayEvents.filter((event) => JSON.stringify(event.fields).includes(engineHost)),
            'relay-a logs nothing about the engine hostname: no handshake, no certificate',
        ).toEqual([]);
    } catch (error) {
        await testInfo.attach('relay-a.pcap', { body: capture, contentType: 'application/vnd.tcpdump.pcap' });
        throw error;
    }
});
