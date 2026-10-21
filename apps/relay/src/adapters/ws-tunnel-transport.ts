import { PING_INTERVAL_MS, TUNNEL_CLOSE_CODE } from '@ptbk/protocol';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';

import type { Clock } from '../domain/clock';
import type { MemoryBudget } from '../domain/limits/memory-budget';
import type { Logger } from '../domain/logger';
import type { ReasonCounters, TunnelTerminationReason } from '../domain/metrics/reason-counters';
import type { Random } from '../domain/random';
import type { PendingConnection, TunnelConnection } from '../domain/tunnel/tunnel-endpoint';

/** A tunnel whose engine has not answered a ping within this long is dead (e.g. behind a NAT that dropped it). */
export const PONG_TIMEOUT_MS = 10_000;
/** Random bytes in each relay ping; only a pong that echoes them proves the engine read it. */
export const PING_PAYLOAD_BYTES = 8;

export interface WsTunnelLimits {
    /** `RELAY_TUNNEL_PING_BUFFER_BYTES`: a ping that finds more queued is not answered; the tunnel is cut. */
    readonly pingBufferBytes: number;
    /** `RELAY_TUNNEL_MAX_BUFFERED_BYTES`: a send that would queue more cuts the tunnel. */
    readonly maxBufferedBytes: number;
}

export interface WsTunnelOptions {
    /** Real time in production; pings must not fire when a test moves the endpoint's fake clock. */
    readonly clock: Clock;
    /** Ping payloads. */
    readonly random: Random;
    readonly logger: Logger;
    readonly limits: WsTunnelLimits;
    /** Frames queued towards engines count against the relay's memory budget. */
    readonly memory: MemoryBudget;
    readonly terminations: Pick<ReasonCounters<TunnelTerminationReason>, 'count'>;
    readonly pingIntervalMs?: number;
    readonly pongTimeoutMs?: number;
}

// `binaryType` stays at its default, `nodebuffer`, so every message (fragmented or not) arrives as one Buffer.
const asBuffer = (data: RawData): Buffer => data as Buffer;

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/**
 * Hands an upgraded WebSocket to the endpoint as a `TunnelConnection` and reports its messages and close. The engine
 * is not trusted with the control plane: the relay answers pings itself and stops answering a peer that does not read
 * the pongs, counts liveness only from pongs that echo its own random payload, and cuts a tunnel whose send queue
 * grows past its cap. Every handler runs guarded, so a bug closes this tunnel with `PROTOCOL_ERROR`, not the process.
 */
export function attachWsTunnel(ws: WebSocket, pending: PendingConnection, options: WsTunnelOptions): void {
    const { clock, random, logger, limits, memory, terminations } = options;
    const { pingIntervalMs = PING_INTERVAL_MS, pongTimeoutMs = PONG_TIMEOUT_MS } = options;
    const isOpen = (): boolean => ws.readyState === WebSocket.OPEN;
    const drainWaiters = new Set<{ readonly below: number; readonly callback: () => void }>();
    // Charged to the memory budget and not yet flushed; whatever is left is settled once, at close.
    let charged = 0;
    let closed = false;

    function terminate(reason: TunnelTerminationReason): void {
        terminations.count(reason);
        logger.warn('tunnel.terminated', { reason });
        ws.terminate();
    }

    function guard(run: () => void): void {
        try {
            run();
        } catch (error) {
            logger.error('tunnel.failed', { problem: errorName(error) });
            terminations.count('failed');
            if (isOpen()) ws.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR, '');
            else ws.terminate();
        }
    }

    // `ws` has no drain event; a send's callback runs once its frame is handed to the socket.
    function written(bytes: number): void {
        if (closed) return;
        charged -= bytes;
        memory.adjust(-bytes);
        if (!isOpen()) return;
        for (const waiter of drainWaiters) {
            if (ws.bufferedAmount < waiter.below) {
                drainWaiters.delete(waiter);
                waiter.callback();
            }
        }
    }

    const connection: TunnelConnection = {
        transport: {
            send(frame) {
                if (!isOpen()) return false;
                if (ws.bufferedAmount + frame.length > limits.maxBufferedBytes) {
                    terminate('send-buffer');
                    return false;
                }
                charged += frame.length;
                memory.adjust(frame.length);
                ws.send(frame, { binary: true }, () => {
                    guard(() => {
                        written(frame.length);
                    });
                });
                return true;
            },
            close(code, reason) {
                if (isOpen()) ws.close(code, reason);
            },
            bufferedBytes: () => ws.bufferedAmount,
            whenBufferedBelow(below, callback) {
                const waiter = { below, callback };
                drainWaiters.add(waiter);
                return () => {
                    drainWaiters.delete(waiter);
                };
            },
        },
        sendText(text) {
            if (isOpen()) ws.send(text, { binary: false });
        },
    };

    let outstanding: Buffer | null = null;
    let cancelPing = (): void => undefined;
    let cancelPongDeadline = (): void => undefined;
    const schedulePing = (): void => {
        cancelPing = clock.setTimeout(() => {
            guard(() => {
                if (!isOpen()) return;
                const payload = Buffer.from(random.bytes(PING_PAYLOAD_BYTES));
                outstanding = payload;
                cancelPongDeadline();
                cancelPongDeadline = clock.setTimeout(() => {
                    terminate('pong-timeout');
                }, pongTimeoutMs);
                ws.ping(payload);
                schedulePing();
            });
        }, pingIntervalMs);
    };

    const events = pending.attach(connection);
    ws.on('message', (data: RawData, isBinary: boolean) => {
        guard(() => {
            if (isBinary) events.binary(asBuffer(data));
            else events.text(asBuffer(data).toString('utf8'));
        });
    });
    ws.on('ping', (data: Buffer) => {
        guard(() => {
            if (!isOpen()) return;
            // A peer that pings without reading the pongs would grow this queue without bound.
            if (ws.bufferedAmount > limits.pingBufferBytes) terminate('ping-buffer');
            else ws.pong(data);
        });
    });
    ws.on('pong', (data: Buffer) => {
        if (outstanding === null || !outstanding.equals(data)) return;
        outstanding = null;
        cancelPongDeadline();
    });
    // Errors (a bad frame, a reset) are always followed by `close`, which reports them.
    ws.on('error', () => undefined);
    ws.once('close', (code: number) => {
        closed = true;
        memory.adjust(-charged);
        charged = 0;
        drainWaiters.clear();
        cancelPing();
        cancelPongDeadline();
        guard(() => {
            events.closed(code);
        });
    });
    schedulePing();
}
