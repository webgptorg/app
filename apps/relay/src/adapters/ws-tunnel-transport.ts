import { PING_INTERVAL_MS } from '@ptbk/protocol';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';

import type { Clock } from '../domain/clock';
import type { PendingConnection, TunnelConnection } from '../domain/tunnel/tunnel-endpoint';

/** A tunnel whose engine has not answered a ping within this long is dead (e.g. behind a NAT that dropped it). */
export const PONG_TIMEOUT_MS = 10_000;

export interface WsLivenessOptions {
    readonly clock: Clock;
    readonly pingIntervalMs?: number;
    readonly pongTimeoutMs?: number;
}

// `binaryType` stays at its default, `nodebuffer`, so every message (fragmented or not) arrives as one Buffer.
const asBuffer = (data: RawData): Buffer => data as Buffer;

/**
 * Hands an upgraded WebSocket to the endpoint as a `TunnelConnection` and reports its messages and close. Pings every
 * `PING_INTERVAL_MS` and terminates the socket when a pong is `PONG_TIMEOUT_MS` late; the endpoint then sees a 1006
 * close.
 */
export function attachWsTunnel(ws: WebSocket, pending: PendingConnection, options: WsLivenessOptions): void {
    const { clock, pingIntervalMs = PING_INTERVAL_MS, pongTimeoutMs = PONG_TIMEOUT_MS } = options;
    const isOpen = (): boolean => ws.readyState === WebSocket.OPEN;
    const connection: TunnelConnection = {
        transport: {
            send(frame) {
                if (!isOpen()) return false;
                ws.send(frame, { binary: true });
                return true;
            },
            close(code, reason) {
                if (isOpen()) ws.close(code, reason);
            },
            bufferedBytes: () => ws.bufferedAmount,
        },
        sendText(text) {
            if (isOpen()) ws.send(text, { binary: false });
        },
    };

    let cancelPing = (): void => undefined;
    let cancelPongDeadline = (): void => undefined;
    const schedulePing = (): void => {
        cancelPing = clock.setTimeout(() => {
            if (!isOpen()) return;
            cancelPongDeadline = clock.setTimeout(() => {
                ws.terminate();
            }, pongTimeoutMs);
            ws.ping();
            schedulePing();
        }, pingIntervalMs);
    };

    const events = pending.attach(connection);
    ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) events.binary(asBuffer(data));
        else events.text(asBuffer(data).toString('utf8'));
    });
    ws.on('pong', () => {
        cancelPongDeadline();
    });
    // Errors (a bad frame, a reset) are always followed by `close`, which reports them.
    ws.on('error', () => undefined);
    ws.once('close', (code: number) => {
        cancelPing();
        cancelPongDeadline();
        events.closed(code);
    });
    schedulePing();
}
