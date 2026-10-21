import type { EngineId } from '@ptbk/protocol';
import type { WebSocket } from 'ws';
import { z } from 'zod';

import type { Clock } from '../../domain/clock';
import type { Route } from './route';
import { defineHttpRoute, defineWebSocketRoute } from './route';

/*
 * Endpoints that prove pages, SSE, WebSockets and bulk transfer work through the passthrough relay (X-01, X-02, R-05).
 * Every parameter is capped so they cannot become an amplification tool.
 */

export const SPIKE_LIMITS = {
    sseMaxCount: 1_000,
    sseMaxIntervalMs: 10_000,
    echoMaxMessageBytes: 1024 * 1024,
    screencastMaxFps: 30,
    screencastMaxFrameBytes: 1024 * 1024,
    downloadMaxBytes: 1024 ** 3,
} as const;

/** Sequence number (u32, big-endian) then send time (float64 ms since the epoch, big-endian). */
export const SCREENCAST_HEADER_BYTES = 12;
export const DOWNLOAD_CHUNK_BYTES = 64 * 1024;
/** The echo stops reading while more than this waits to be sent, so a client that never reads cannot grow it. */
const ECHO_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/**
 * A screencast drops a frame rather than queue it behind two others, as a real one would. The floor keeps tiny frames
 * from being dropped behind a few bytes of unrelated buffered output, such as the upgrade response.
 */
const SCREENCAST_MAX_QUEUED_FRAMES = 2;
const SCREENCAST_MIN_QUEUE_BYTES = 64 * 1024;

const DOWNLOAD_PATTERN = Uint8Array.from({ length: DOWNLOAD_CHUNK_BYTES }, (_, index) => index % 251);

/** A decimal integer within bounds; anything else (sign, exponent, leading zeros, over the cap) fails. */
function integer(min: number, max: number) {
    return z
        .string()
        .regex(/^(?:0|[1-9]\d{0,9})$/)
        .transform(Number)
        .pipe(z.int().min(min).max(max));
}

export interface SpikeRouteDeps {
    readonly engineId: EngineId;
    readonly clock: Clock;
    /**
     * Random per engine start and shown on the spike page, so a packet capture (X-02) can prove the page never crosses
     * the relay in plaintext. Public, not a secret: anyone who loads the page sees it.
     */
    readonly canary: string;
    /** Bytes the download route produced, as it produces them (throughput and backpressure measurements). */
    readonly onDownloadBytes?: (bytes: number) => void;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

function spikePage(engineId: EngineId, canary: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Promptbook mock engine</title>
</head>
<body>
<h1>Promptbook mock engine</h1>
<p>Engine ID: <code id="engine-id">${escapeHtml(engineId)}</code></p>
<p>Canary: <code id="canary">${escapeHtml(canary)}</code></p>
<p>TLS for this page ended on the engine, not on the relay.</p>
<ul>
<li><a href="/__spike/whoami">/__spike/whoami</a></li>
<li><a href="/__spike/sse?count=5&amp;intervalMs=500">/__spike/sse</a></li>
<li><a href="/__spike/download?bytes=1048576">/__spike/download</a></li>
</ul>
</body>
</html>
`;
}

function sseStream(clock: Clock, first: number, count: number, intervalMs: number, signal: AbortSignal) {
    const encoder = new TextEncoder();
    let cancel: (() => void) | undefined;
    const stop = (): void => {
        cancel?.();
        cancel = undefined;
    };
    return new ReadableStream<Uint8Array>({
        start(controller) {
            const startMs = clock.nowMs();
            let next = first;
            const send = (): void => {
                controller.enqueue(encoder.encode(`id: ${String(next)}\ndata: {"id":${String(next)}}\n\n`));
                next++;
                if (next > count) {
                    cancel = undefined;
                    controller.close();
                    return;
                }
                cancel = clock.setTimeout(send, startMs + (next - first) * intervalMs - clock.nowMs());
            };
            signal.addEventListener('abort', stop, { once: true });
            send();
        },
        cancel: stop,
    });
}

function downloadStream(bytes: number, onBytes: ((bytes: number) => void) | undefined) {
    let remaining = bytes;
    // highWaterMark 0: a chunk is produced only when the response asks for one, i.e. when the socket drained.
    return new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                if (remaining === 0) {
                    controller.close();
                    return;
                }
                const size = Math.min(DOWNLOAD_CHUNK_BYTES, remaining);
                remaining -= size;
                onBytes?.(size);
                controller.enqueue(DOWNLOAD_PATTERN.slice(0, size));
            },
        },
        { highWaterMark: 0 },
    );
}

function echo(socket: WebSocket): void {
    socket.on('message', (data, isBinary) => {
        socket.send(data, { binary: isBinary }, () => {
            if (socket.isPaused && socket.bufferedAmount < ECHO_HIGH_WATER_BYTES / 2) socket.resume();
        });
        if (socket.bufferedAmount > ECHO_HIGH_WATER_BYTES) socket.pause();
    });
}

function screencast(socket: WebSocket, clock: Clock, fps: number, frameBytes: number): void {
    const startMs = clock.nowMs();
    const intervalMs = 1000 / fps;
    let sequence = 0;
    const maxQueuedBytes = Math.max(frameBytes * SCREENCAST_MAX_QUEUED_FRAMES, SCREENCAST_MIN_QUEUE_BYTES);
    let cancel: (() => void) | undefined;
    const tick = (): void => {
        if (socket.bufferedAmount < maxQueuedBytes) {
            const frame = Buffer.alloc(frameBytes);
            frame.writeUInt32BE(sequence >>> 0, 0);
            frame.writeDoubleBE(clock.nowMs(), 4);
            socket.send(frame, { binary: true });
        }
        sequence++;
        cancel = clock.setTimeout(tick, startMs + sequence * intervalMs - clock.nowMs());
    };
    socket.once('close', () => cancel?.());
    tick();
}

const NO_QUERY = z.strictObject({});

export function createSpikeRoutes(deps: SpikeRouteDeps): readonly Route[] {
    const { clock, engineId } = deps;
    const page = spikePage(engineId, deps.canary);
    const pageRoute = (path: '/__spike/') =>
        defineHttpRoute({
            transport: 'http',
            params: null,
            body: null,
            method: 'GET',
            path,
            auth: 'public',
            permission: null,
            rateLimit: 'spike-ip',
            query: NO_QUERY,
            headers: null,
            handle: () => new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
        });

    return [
        pageRoute('/__spike/'),
        defineHttpRoute({
            transport: 'http',
            params: null,
            body: null,
            method: 'GET',
            path: '/__spike/whoami',
            auth: 'public',
            permission: null,
            rateLimit: 'spike-ip',
            query: NO_QUERY,
            headers: null,
            handle: ({ connection }) =>
                Response.json({
                    engineId,
                    hostname: connection.hostname,
                    clientIp: connection.clientIp,
                    alpn: connection.alpn,
                    tlsVersion: connection.tlsVersion,
                }),
        }),
        defineHttpRoute({
            transport: 'http',
            params: null,
            body: null,
            method: 'GET',
            path: '/__spike/sse',
            auth: 'public',
            permission: null,
            rateLimit: 'spike-ip',
            query: z.strictObject({
                count: integer(1, SPIKE_LIMITS.sseMaxCount).default(20),
                intervalMs: integer(0, SPIKE_LIMITS.sseMaxIntervalMs).default(1000),
            }),
            headers: z.strictObject({ 'last-event-id': integer(0, SPIKE_LIMITS.sseMaxCount).optional() }),
            handle: ({ query, headers, signal }) => {
                const first = (headers['last-event-id'] ?? 0) + 1;
                // 204 tells an EventSource that reconnects after the last event to stop.
                if (first > query.count) return new Response(null, { status: 204 });
                return new Response(sseStream(clock, first, query.count, query.intervalMs, signal), {
                    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
                });
            },
        }),
        defineWebSocketRoute({
            transport: 'websocket',
            params: null,
            method: 'GET',
            path: '/__spike/ws',
            auth: 'public',
            permission: null,
            rateLimit: 'spike-ip',
            query: NO_QUERY,
            headers: null,
            maxPayloadBytes: SPIKE_LIMITS.echoMaxMessageBytes,
            handle: echo,
        }),
        defineWebSocketRoute({
            transport: 'websocket',
            params: null,
            method: 'GET',
            path: '/__spike/screencast',
            auth: 'public',
            permission: null,
            rateLimit: 'spike-bulk-ip',
            query: z.strictObject({
                fps: integer(1, SPIKE_LIMITS.screencastMaxFps).default(5),
                bytes: integer(SCREENCAST_HEADER_BYTES, SPIKE_LIMITS.screencastMaxFrameBytes).default(64 * 1024),
            }),
            headers: null,
            // The screencast only sends; anything the client sends is small control traffic at most.
            maxPayloadBytes: 1024,
            handle: (socket, { query }) => {
                screencast(socket, clock, query.fps, query.bytes);
            },
        }),
        defineHttpRoute({
            transport: 'http',
            params: null,
            body: null,
            method: 'GET',
            path: '/__spike/download',
            auth: 'public',
            permission: null,
            rateLimit: 'spike-bulk-ip',
            query: z.strictObject({ bytes: integer(0, SPIKE_LIMITS.downloadMaxBytes) }),
            headers: null,
            handle: ({ query }) =>
                new Response(downloadStream(query.bytes, deps.onDownloadBytes), {
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': String(query.bytes),
                    },
                }),
        }),
    ];
}
