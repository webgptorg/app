import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FrameType, TUNNEL_PATH, decodeFrame, parseClientHello } from '@ptbk/protocol';

import { expect, test } from '../../src/fixtures.ts';
import { checkTlsStream } from '../../src/pcap/tls-records.ts';
import { findPlaintext } from '../../src/pcap/plaintext.ts';
import { MITM_FILES, MITM_MOUNT, RELAYS } from '../../src/stack.ts';

interface RecordedMessage {
    readonly host: string;
    readonly path: string;
    /** The WebSocket client is the engine: true is engine to relay. */
    readonly fromClient: boolean;
    readonly binary: boolean;
    readonly content: Buffer;
}

async function recordedMessages(): Promise<readonly RecordedMessage[]> {
    const text = await readFile(join(MITM_MOUNT, MITM_FILES.websocketMessages), 'utf8');
    return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
            const raw = JSON.parse(line) as Record<string, unknown>;
            if (
                typeof raw['host'] !== 'string' ||
                typeof raw['path'] !== 'string' ||
                typeof raw['fromClient'] !== 'boolean' ||
                typeof raw['binary'] !== 'boolean' ||
                typeof raw['content'] !== 'string'
            ) {
                throw new Error('not a websocket record');
            }
            return {
                host: raw['host'],
                path: raw['path'],
                fromClient: raw['fromClient'],
                binary: raw['binary'],
                content: Buffer.from(raw['content'], 'base64'),
            };
        });
}

/** The bytes each tunnel stream carried, per direction, joined from its DATA frames. */
function streamBytes(messages: readonly RecordedMessage[]): Map<string, Buffer> {
    const chunks = new Map<string, Buffer[]>();
    for (const message of messages) {
        if (!message.binary) continue;
        const decoded = decodeFrame(message.content);
        if (decoded.kind !== 'frame') throw new Error(`a tunnel message is not a valid frame (${decoded.kind})`);
        if (decoded.frame.type !== FrameType.DATA) continue;
        const key = `${message.host} stream ${String(decoded.frame.streamId)} ${message.fromClient ? 'engine->relay' : 'relay->engine'}`;
        chunks.set(key, [...(chunks.get(key) ?? []), Buffer.from(decoded.frame.payload)]);
    }
    return new Map([...chunks].map(([key, parts]) => [key, Buffer.concat(parts)]));
}

/*
 * A corporate proxy that inspects TLS terminates the engine's connection to the relay and reads the tunnel. What it
 * finds there is the browser's TLS, which ends in the engine: the browser still sees the engine's certificate, and
 * every byte stream in the tunnel is TLS records, never the page or HTTP.
 */
test('through a TLS-inspecting proxy the browser still talks TLS to the engine, and the proxy sees only that TLS', async ({
    page,
    engineId,
    engineHost,
    spikeUrl,
    engineCertSha256,
    peerCertificateSha256,
}) => {
    const response = await page.goto(spikeUrl);
    expect(response?.status()).toBe(200);
    await expect(page.locator('#engine-id')).toHaveText(engineId);
    expect(await peerCertificateSha256(page), "the engine's own certificate").toBe(engineCertSha256);
    const canary = (await page.locator('#canary').textContent()) ?? '';
    expect(canary).toMatch(/^[0-9a-f]{32}$/);

    const messages = await recordedMessages();
    for (const relay of RELAYS) {
        const tunnel = messages.filter((message) => message.host === relay.hostname && message.path === TUNNEL_PATH);
        // Inspection happened: the proxy read the handshake both ways, which only a TLS endpoint can.
        expect(
            tunnel.some((message) => !message.binary && !message.fromClient),
            `${relay.hostname} challenge`,
        ).toBe(true);
        expect(
            tunnel.some((message) => !message.binary && message.fromClient),
            `${relay.hostname} auth`,
        ).toBe(true);
    }

    const streams = streamBytes(messages);
    const opened = [...streams].filter(([key, bytes]) => {
        if (!key.endsWith('relay->engine')) return false;
        const hello = parseClientHello(bytes, { maxBytes: 16_384 });
        return hello.kind === 'sni' && hello.hostname === engineHost;
    });
    expect(opened.length, 'browser streams to the engine inside the tunnels').toBeGreaterThan(0);
    const problems = [...streams].flatMap(([key, bytes]) => {
        const check = checkTlsStream(bytes, { allowTruncatedTail: true });
        return check.kind === 'tls' ? [] : [`${key}: ${check.problem.description}`];
    });
    expect(problems).toEqual([]);
    const hits = findPlaintext(
        [...streams].map(([label, bytes]) => ({ label, bytes })),
        [canary, 'HTTP/1.1', 'GET /', '/__spike/'],
    );
    expect(hits).toEqual([]);
});
