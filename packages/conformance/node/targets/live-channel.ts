import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { ENGINE_API_PREFIX, LIVE_CHANNEL_PATH, LIVE_CHANNEL_SUBPROTOCOL } from '@ptbk/engine-api';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';

import type { LiveBrowserTarget, LiveChannelOpen, SessionCredential } from '../../src/index';
import { LiveChannelQueue } from '../../src/testing/live-channel-queue';

/** Far above any control message or frame a conforming engine sends; it only keeps a broken one from flooding the run. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

/** With the default `binaryType`, every message arrives as one `Buffer`, fragmented ones included. */
function bytesOf(data: RawData): Uint8Array {
    return data as Buffer;
}

/**
 * Opens `LIVE_CHANNEL_PATH` as a browser on the engine's page would: a WebSocket over `connect` (a TLS connection to
 * the engine through the relay), offering `LIVE_CHANNEL_SUBPROTOCOL`, with the credential's cookie and `origin`. A
 * refused upgrade answers its HTTP status.
 */
export function createLiveChannelOpener(
    baseUrl: URL,
    connect: () => Promise<Duplex>,
    timeoutMs: number,
): LiveBrowserTarget['openChannel'] {
    return async (sessionId: string, credential: SessionCredential | null, origin: string | null) => {
        const socket = await connect();
        const headers: Record<string, string> = {};
        if (credential !== null && 'cookie' in credential) headers['Cookie'] = credential.cookie;
        if (credential !== null && 'bearer' in credential) headers['Authorization'] = `Bearer ${credential.bearer}`;
        const path = `${ENGINE_API_PREFIX}${LIVE_CHANNEL_PATH.replace('{sessionId}', encodeURIComponent(sessionId))}`;
        const ws = new WebSocket(new URL(path, `wss://${baseUrl.host}`), [LIVE_CHANNEL_SUBPROTOCOL], {
            createConnection: () => socket,
            headers,
            perMessageDeflate: false,
            maxPayload: MAX_MESSAGE_BYTES,
            handshakeTimeout: timeoutMs,
            // The origin is the test's to choose, so a foreign or missing one can be tried.
            ...(origin === null ? {} : { origin }),
        });
        const queue = new LiveChannelQueue(
            (data) => {
                ws.send(data, { binary: typeof data !== 'string' });
            },
            () => {
                ws.close();
            },
        );
        ws.on('message', (data, isBinary) => {
            const bytes = bytesOf(data);
            queue.push(isBinary ? { kind: 'binary', bytes } : { kind: 'text', text: new TextDecoder().decode(bytes) });
        });
        ws.on('close', (code) => {
            queue.push({ kind: 'closed', code });
        });
        return new Promise<LiveChannelOpen>((resolve, reject) => {
            ws.once('open', () => {
                resolve({ kind: 'open', channel: queue });
            });
            ws.once('unexpected-response', (_request, response: IncomingMessage) => {
                response.resume();
                socket.destroy();
                resolve({ kind: 'refused', status: response.statusCode ?? 0 });
            });
            // `ws` is already closing when it reports a failed handshake; after `open` or a refusal this is a no-op.
            ws.on('error', reject);
        });
    };
}
