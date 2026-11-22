import { ENGINE_API_PREFIX, LIVE_CHANNEL_PATH, LIVE_CHANNEL_SUBPROTOCOL } from '@ptbk/engine-api';
import type { LiveSessionId } from '@ptbk/engine-api';

/** What a live session's channel reports: text messages as strings, media as bytes, then one `onClose`. */
export interface LiveChannelHandlers {
    readonly onOpen: () => void;
    readonly onMessage: (data: string | Uint8Array) => void;
    readonly onClose: () => void;
}

export interface LiveChannelConnection {
    /** Dropped once the channel is closed or not yet open. */
    readonly send: (text: string) => void;
    readonly close: () => void;
}

/**
 * Opens a live session's channel. In the app a WebSocket on the engine origin; tests bind the in-memory engine. A
 * refused upgrade only closes: the session's own state (`GET /browser-sessions/{id}`) says why.
 */
export type OpenLiveChannel = (sessionId: LiveSessionId, handlers: LiveChannelHandlers) => LiveChannelConnection;

export function liveChannelUrl(origin: string, sessionId: LiveSessionId): URL {
    const url = new URL(
        ENGINE_API_PREFIX + LIVE_CHANNEL_PATH.replace('{sessionId}', encodeURIComponent(sessionId)),
        origin,
    );
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return url;
}

/**
 * The channel as the engine serves it: a WebSocket to the engine's own origin, inside the same TLS as every request,
 * authenticated by the session cookie alone. Nothing secret goes in the URL or the subprotocol.
 */
export function createWebSocketLiveChannels(
    origin: string,
    WebSocketImpl: typeof WebSocket = WebSocket,
): OpenLiveChannel {
    return (sessionId, handlers) => {
        const socket = new WebSocketImpl(liveChannelUrl(origin, sessionId), LIVE_CHANNEL_SUBPROTOCOL);
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('open', () => {
            handlers.onOpen();
        });
        socket.addEventListener('message', (event: MessageEvent<unknown>) => {
            if (typeof event.data === 'string') handlers.onMessage(event.data);
            else if (event.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(event.data));
        });
        socket.addEventListener('close', () => {
            handlers.onClose();
        });
        return {
            send: (text) => {
                if (socket.readyState === WebSocketImpl.OPEN) socket.send(text);
            },
            close: () => {
                socket.close(1000);
            },
        };
    };
}
