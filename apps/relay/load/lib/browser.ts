import type { SecureContext, TLSSocket } from 'node:tls';
import { connect as connectTls } from 'node:tls';

import { WebSocket } from 'ws';

import { FRAME_HEADER_BYTES } from './engine-server';
import { wallMs } from './fleet-stats';

export interface BrowserTarget {
    readonly relayHost: string;
    readonly relayPort: number;
    /** The engine's hostname: the SNI the relay routes by, and the name the engine's certificate is checked for. */
    readonly hostname: string;
    readonly trust: SecureContext;
}

/** A TLS connection to the engine through the relay, as a browser makes it. */
export function connectThroughRelay(target: BrowserTarget): TLSSocket {
    return connectTls({
        host: target.relayHost,
        port: target.relayPort,
        servername: target.hostname,
        secureContext: target.trust,
        ALPNProtocols: ['http/1.1'],
        minVersion: 'TLSv1.3',
    });
}

export interface StreamMeter {
    measuring: boolean;
    frames: number;
    bytes: number;
    latenciesMs: number[];
    /** The engine's dropped-frame counter, at the first and the last measured frame. */
    droppedAtStart: number | null;
    droppedAtEnd: number;
}

export function createMeter(): StreamMeter {
    return { measuring: false, frames: 0, bytes: 0, latenciesMs: [], droppedAtStart: null, droppedAtEnd: 0 };
}

export interface BrowserStream {
    readonly meter: StreamMeter;
    readonly opened: Promise<void>;
    /** Resolves with the close code; 1005 after our own close. */
    readonly closed: Promise<number>;
    close(): void;
}

function open(
    target: BrowserTarget,
    path: string,
    onMessage: (data: Buffer, meter: StreamMeter) => void,
): BrowserStream {
    const meter = createMeter();
    const ws = new WebSocket(`wss://${target.hostname}${path}`, {
        createConnection: () => connectThroughRelay(target),
        perMessageDeflate: false,
        maxPayload: 32 << 20,
        handshakeTimeout: 15_000,
    });
    ws.on('error', () => undefined);
    ws.on('message', (data: Buffer) => {
        onMessage(data, meter);
    });
    const opened = new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('close', () => {
            reject(new Error(`no WebSocket to ${target.hostname}`));
        });
    });
    opened.catch(() => undefined);
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    return {
        meter,
        opened,
        closed,
        close() {
            ws.close(1000);
        },
    };
}

export function openScreencast(target: BrowserTarget, frameBytes: number, fps: number): BrowserStream {
    return open(target, `/screencast?bytes=${String(frameBytes)}&fps=${String(fps)}`, (data, meter) => {
        if (!meter.measuring || data.length < FRAME_HEADER_BYTES) return;
        const dropped = data.readUInt32LE(12);
        meter.droppedAtStart ??= dropped;
        meter.droppedAtEnd = dropped;
        meter.frames++;
        meter.bytes += data.length;
        meter.latenciesMs.push(wallMs() - data.readDoubleLE(0));
    });
}

export function openBulk(target: BrowserTarget): BrowserStream {
    return open(target, '/bulk', (data, meter) => {
        if (!meter.measuring) return;
        meter.frames++;
        meter.bytes += data.length;
    });
}
