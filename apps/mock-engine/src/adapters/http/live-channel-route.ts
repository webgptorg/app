import {
    BrowserSessionParams,
    ENGINE_API_PREFIX,
    LIVE_CHANNEL_PATH,
    LIVE_CHANNEL_SUBPROTOCOL,
    MAX_LIVE_CONTROL_MESSAGE_BYTES,
    MAX_LIVE_MEDIA_BYTES,
} from '@ptbk/engine-api';
import type { InMemoryEngineCore, LiveChannelSink } from '@ptbk/engine-api/in-memory';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';

import type { WebSocketRoute } from './route';
import { defineWebSocketRoute } from './route';

/** The browser sends only control messages; a little headroom lets the core answer an oversized one itself. */
export const LIVE_CHANNEL_MAX_PAYLOAD_BYTES = MAX_LIVE_CONTROL_MESSAGE_BYTES + 1024;

/**
 * The ack credit keeps an honest viewer at a couple of frames in flight, far below this. A client that acks frames it
 * never read (sequence numbers are predictable) would make the socket queue without bound, so above it frames are
 * dropped instead of queued.
 */
export const LIVE_CHANNEL_HIGH_WATER_BYTES = 16 * MAX_LIVE_MEDIA_BYTES;

const decoder = new TextDecoder();

/** With the default `binaryType`, every message arrives as one `Buffer`, fragmented ones included. */
function bytesOf(data: RawData): Uint8Array {
    return data as Buffer;
}

/**
 * The live channel (`browser-tab@1`) at `LIVE_CHANNEL_PATH`: the HTTP app has already checked the gateway cookie, the
 * `Origin` and the `ptbk-live` subprotocol, so what is left is the core's answer, given before the handshake completes
 * so a refusal is a plain HTTP problem. Nothing a message carries is logged: frames show the tab, input is what a
 * person types.
 */
export function createLiveChannelRoute(deps: { readonly core: () => InMemoryEngineCore }): WebSocketRoute {
    return defineWebSocketRoute({
        transport: 'websocket',
        method: 'GET',
        path: `${ENGINE_API_PREFIX}${LIVE_CHANNEL_PATH}`,
        auth: 'session',
        // The core decides: `browser.watch`, or `browser.control` alone, attaches the member's own session.
        permission: 'browser.watch',
        rateLimit: 'live-channel-ip',
        params: BrowserSessionParams,
        // No token in the URL: the cookie is the only credential, and URLs end up in logs.
        query: z.strictObject({}),
        headers: null,
        maxPayloadBytes: LIVE_CHANNEL_MAX_PAYLOAD_BYTES,
        subprotocol: LIVE_CHANNEL_SUBPROTOCOL,
        handle: ({ params, actor }) => {
            let socket: WebSocket | null = null;
            const sink: LiveChannelSink = {
                send(data) {
                    if (socket === null || socket.readyState !== socket.OPEN) return;
                    if (typeof data === 'string') {
                        socket.send(data);
                        return;
                    }
                    if (socket.bufferedAmount > LIVE_CHANNEL_HIGH_WATER_BYTES) return;
                    socket.send(data, { binary: true });
                },
                close(code) {
                    socket?.close(code);
                },
            };
            const attached = deps.core().attachLiveChannel(actor, params.sessionId, sink);
            if (attached.kind === 'refused') return { kind: 'refuse', problem: attached.problem };
            const { peer } = attached;
            let dropped = false;
            const drop = (): void => {
                if (dropped) return;
                dropped = true;
                peer.closed();
            };
            return {
                kind: 'accept',
                open(ws) {
                    socket = ws;
                    ws.on('message', (data, isBinary) => {
                        const bytes = bytesOf(data);
                        peer.receive(isBinary ? bytes : decoder.decode(bytes));
                    });
                    ws.once('close', () => {
                        drop();
                    });
                },
                abandoned() {
                    drop();
                },
            };
        },
    });
}
