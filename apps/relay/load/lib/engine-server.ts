import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { Duplex } from 'node:stream';

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { wallMs } from './fleet-stats';
import { PATHS } from './fixtures';

/** `[f64 sent at, wall ms][u32 sequence][u32 frames dropped so far]`, then filler. */
export const FRAME_HEADER_BYTES = 16;
const BULK_MESSAGE_BYTES = 65_536;
const BULK_HIGH_WATER_BYTES = 1_048_576;
const BLOB_CHUNK_BYTES = 65_536;
// Incompressible filler, like an encoded video frame; compression is off on every hop anyway.
const FILLER = randomBytes(1_048_576);

export interface EngineServer {
    /** Terminates TLS on one tunnel stream, with the engines' own key; the relay only ever sees ciphertext. */
    handle(stream: Duplex): void;
    close(): void;
}

function positiveInt(value: string | null, fallback: number, max: number): number {
    const parsed = Number(value);
    return value !== null && Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/**
 * Screencast frames at a fixed rate. Like a real screencast (CDP waits for the ack of each frame), a frame that would
 * queue behind more than one unsent frame is dropped instead of queued, so backpressure shows up as lower fps rather
 * than as unbounded latency.
 */
function screencast(ws: WebSocket, frameBytes: number, fps: number): void {
    const intervalMs = 1000 / fps;
    const startedAt = performance.now();
    let sequence = 0;
    let dropped = 0;
    let timer: NodeJS.Timeout | undefined;
    const tick = (): void => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > frameBytes) {
            dropped++;
        } else {
            const frame = Buffer.allocUnsafe(frameBytes);
            FILLER.copy(frame, FRAME_HEADER_BYTES, 0, frameBytes - FRAME_HEADER_BYTES);
            frame.writeDoubleLE(wallMs(), 0);
            frame.writeUInt32LE(sequence++, 8);
            frame.writeUInt32LE(dropped, 12);
            ws.send(frame, { binary: true });
        }
        const due = startedAt + (sequence + dropped) * intervalMs;
        timer = setTimeout(tick, Math.max(0, due - performance.now()));
    };
    tick();
    ws.once('close', () => {
        clearTimeout(timer);
    });
}

/** As fast as the path takes it: whatever the relay's credit and the engine's bandwidth budget allow. */
function bulk(ws: WebSocket): void {
    const message = FILLER.subarray(0, BULK_MESSAGE_BYTES);
    const pump = (): void => {
        while (ws.readyState === ws.OPEN && ws.bufferedAmount < BULK_HIGH_WATER_BYTES) {
            ws.send(message, { binary: true }, () => {
                if (ws.bufferedAmount < BULK_HIGH_WATER_BYTES / 2) setImmediate(pump);
            });
        }
    };
    pump();
}

/** `bytes` of body for a browser that may never read it: the engine writes only as fast as credit comes back. */
function blob(response: ServerResponse, bytes: number): void {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes) });
    let left = bytes;
    const write = (): void => {
        while (left > 0) {
            const size = Math.min(left, BLOB_CHUNK_BYTES);
            left -= size;
            if (!response.write(FILLER.subarray(0, size))) {
                response.once('drain', write);
                return;
            }
        }
        response.end();
    };
    write();
}

export async function createEngineServer(): Promise<EngineServer> {
    const server = createServer({
        cert: await readFile(PATHS.engineCert, 'utf8'),
        key: await readFile(PATHS.engineKey, 'utf8'),
        minVersion: 'TLSv1.3',
        ALPNProtocols: ['http/1.1'],
    });
    const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? '/', 'https://engine');
        if (url.pathname === '/blob') {
            blob(response, positiveInt(url.searchParams.get('bytes'), 1024, 1 << 30));
            return;
        }
        response.writeHead(404).end();
    });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(request.url ?? '/', 'https://engine');
        webSockets.handleUpgrade(request, socket, head, (ws) => {
            ws.on('error', () => undefined);
            if (url.pathname === '/screencast') {
                screencast(
                    ws,
                    Math.max(FRAME_HEADER_BYTES, positiveInt(url.searchParams.get('bytes'), 102_400, 16 << 20)),
                    positiveInt(url.searchParams.get('fps'), 5, 120),
                );
            } else if (url.pathname === '/bulk') {
                bulk(ws);
            } else {
                ws.close(1008);
            }
        });
    });
    server.on('tlsClientError', (_error: Error, socket: Duplex) => {
        socket.destroy();
    });
    return {
        handle(stream) {
            stream.on('error', () => undefined);
            server.emit('connection', stream);
        },
        close() {
            webSockets.close();
            server.close();
        },
    };
}
