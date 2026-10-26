import { ENGINE_API_PREFIX } from '@ptbk/engine-api';
import {
    FRAME_HEADER_BYTES,
    FrameType,
    MAX_FRAME_PAYLOAD_BYTES,
    StreamId,
    TUNNEL_CLOSE_CODE,
    encodeFrame,
} from '@ptbk/protocol';

import { Findings, fail } from '../../../src/check';
import type { RelayTunnel } from '../../fake-relay/relay-tunnel';
import { readResponses, requestBytes } from '../http1';
import { engineAnswerProblem, engineHostname, getEngine } from '../through-stream';
import type { TunnelCheckContext, TunnelCheckRun } from './support';
import { closeWithin, engineAlive, readyTunnel, tlsToEngine } from './support';

/** At about 1.5 KiB per answer, enough to fill one window. */
const PIPELINED = 200;

function header(typeByte: number, streamId: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const bytes = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, typeByte);
    view.setUint32(1, streamId);
    bytes.set(payload, FRAME_HEADER_BYTES);
    return bytes;
}

function openFrame(streamId: number): Uint8Array {
    return encodeFrame({
        type: FrameType.OPEN,
        streamId: StreamId.parse(streamId),
        family: 4,
        address: Uint8Array.of(203, 0, 113, 7),
        port: 40_000,
    });
}

/** WebSocket "message too big": an engine may refuse an oversized frame before decoding it, which is as good. */
const WS_MESSAGE_TOO_BIG = 1009;

interface BreakingVariant {
    readonly name: string;
    /** Close codes accepted besides `PROTOCOL_ERROR`. */
    readonly alsoAccepted?: readonly number[];
    /** Sends what must make the engine close the tunnel; may open streams first. */
    send(tunnel: RelayTunnel): void;
}

/**
 * Each variant on a fresh tunnel to the primary relay: the engine must close it with `PROTOCOL_ERROR` and come back,
 * still running.
 */
async function expectEachClosesTunnel(
    ctx: TunnelCheckContext,
    variants: readonly BreakingVariant[],
): Promise<Findings> {
    const { runtime } = ctx;
    await runtime.calm(ctx.signal);
    const findings = new Findings();
    for (const variant of variants) {
        const tunnel = await readyTunnel(ctx);
        variant.send(tunnel);
        const sentAt = performance.now();
        const closed = await closeWithin(tunnel.connection, runtime.timing.closeMs);
        if (closed.kind === 'open') {
            findings.add(`${variant.name}: the engine kept the tunnel open`);
            tunnel.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        } else if (
            closed.code !== TUNNEL_CLOSE_CODE.PROTOCOL_ERROR &&
            !(variant.alsoAccepted ?? []).includes(closed.code)
        ) {
            findings.add(`${variant.name}: the engine closed with ${String(closed.code)}, not PROTOCOL_ERROR`);
        }
        runtime.disrupted();
        const back = await runtime.waitReady(runtime.primary, runtime.timing.reconnectMs, ctx.signal, sentAt);
        if (back === null) {
            findings.add(
                `${variant.name}: the engine did not reconnect within ${String(runtime.timing.reconnectMs)} ms`,
            );
            break;
        }
    }
    const dead = engineAlive(ctx);
    if (dead !== null) findings.add(dead);
    return findings;
}

export const ignorableIgnored: TunnelCheckRun = async (ctx) => {
    const tunnel = await readyTunnel(ctx);
    const hostname = engineHostname(tunnel, ctx.runtime.engine.engineDomain);
    const connected = await tlsToEngine(ctx, tunnel);
    if (connected.kind === 'failed') fail(`TLS through a stream to the default hostname: ${connected.reason}`);
    const findings = new Findings();
    try {
        const id = connected.stream.id;
        // Codes 5–127 with the flag: on a live stream, on stream 0 and on one never opened, as the codec allows.
        tunnel.sendRaw(header(0x85, id, Uint8Array.of(1, 2, 3, 4)));
        tunnel.sendRaw(header(0xff, 0, new Uint8Array(16)));
        tunnel.sendRaw(header(0x9a, id + 1_000));
        const answer = await getEngine(connected.socket, hostname, null, ctx.runtime.timing.requestMs);
        if (answer.kind === 'failed') findings.add(`after ignorable frames, GET /api/v1/engine: ${answer.reason}`);
        else {
            const wrong = engineAnswerProblem(answer.response, tunnel.auth.engineId, false);
            if (wrong !== null) findings.add(wrong);
        }
    } finally {
        connected.socket.destroy();
    }
    if (!tunnel.isOpen()) findings.add('the engine closed the tunnel over an ignorable frame');
    return findings.outcome();
};

export const validFromEngine: TunnelCheckRun = async (ctx) => {
    const tunnel = await readyTunnel(ctx);
    const connected = await tlsToEngine(ctx, tunnel);
    if (connected.kind === 'failed') fail(`TLS through a stream to the default hostname: ${connected.reason}`);
    const findings = new Findings();
    try {
        // Enough answers to fill the window, so the engine writes as much as it can per frame.
        const request = requestBytes({
            host: engineHostname(tunnel, ctx.runtime.engine.engineDomain),
            path: `${ENGINE_API_PREFIX}/engine`,
        });
        const reading = readResponses(connected.socket, PIPELINED, ctx.runtime.timing.requestMs * 4);
        connected.socket.write(Buffer.concat(Array.from({ length: PIPELINED }, () => request)));
        const read = await reading;
        if (read.kind === 'failed') findings.add(`${String(PIPELINED)} pipelined requests: ${read.reason}`);
    } finally {
        connected.socket.destroy();
    }
    // Every tunnel of the run so far, so a frame the engine got wrong in any earlier check counts too.
    const seen = new Set<string>();
    let largest = 0;
    for (const each of ctx.runtime.allTunnels) {
        for (const problem of each.problems) seen.add(problem);
        for (const frame of each.frames) largest = Math.max(largest, frame.size - FRAME_HEADER_BYTES);
    }
    for (const problem of seen) findings.add(problem);
    if (largest > MAX_FRAME_PAYLOAD_BYTES) findings.add(`a frame carried ${String(largest)} payload bytes`);
    return findings.outcome();
};

export const unknownTypeRefused: TunnelCheckRun = async (ctx) => {
    const findings = await expectEachClosesTunnel(ctx, [
        {
            name: 'an unknown code (5) without the ignorable flag',
            send: (tunnel) => {
                tunnel.sendRaw(header(0x05, 1, Uint8Array.of(0)));
            },
        },
        {
            name: 'DATA with the ignorable flag set',
            send(tunnel) {
                const stream = tunnel.openStream();
                tunnel.sendRaw(header(0x80 | FrameType.DATA, stream.id, Uint8Array.of(0x16)));
            },
        },
        {
            name: 'code 0 with the ignorable flag',
            send: (tunnel) => {
                tunnel.sendRaw(header(0x80, 1));
            },
        },
    ]);
    return findings.outcome();
};

export const malformedRefused: TunnelCheckRun = async (ctx) => {
    const findings = await expectEachClosesTunnel(ctx, [
        {
            name: 'a frame shorter than its header',
            send: (tunnel) => {
                tunnel.sendRaw(Uint8Array.of(FrameType.DATA, 0, 0));
            },
        },
        {
            name: 'a WINDOW with a zero increment',
            send(tunnel) {
                const stream = tunnel.openStream();
                tunnel.sendRaw(header(FrameType.WINDOW, stream.id, new Uint8Array(4)));
            },
        },
        {
            name: 'DATA one byte over MAX_FRAME_PAYLOAD_BYTES',
            alsoAccepted: [WS_MESSAGE_TOO_BIG],
            send(tunnel) {
                const stream = tunnel.openStream();
                tunnel.sendRaw(header(FrameType.DATA, stream.id, new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1)));
            },
        },
        {
            name: 'an OPEN with a bad address family',
            send(tunnel) {
                const id = tunnel.nextStreamId;
                tunnel.skipStreamIds(id + 1);
                tunnel.sendRaw(header(FrameType.OPEN, id, Uint8Array.of(5, 203, 0, 113, 7, 0, 80)));
            },
        },
    ]);
    return findings.outcome();
};

export const streamIdRules: TunnelCheckRun = async (ctx) => {
    const findings = await expectEachClosesTunnel(ctx, [
        {
            name: 'a duplicate OPEN',
            send(tunnel) {
                const stream = tunnel.openStream();
                tunnel.sendRaw(openFrame(stream.id));
            },
        },
        {
            name: 'an OPEN reusing a closed stream ID',
            send(tunnel) {
                const stream = tunnel.openStream();
                stream.closeFromRelay();
                tunnel.sendRaw(openFrame(stream.id));
            },
        },
        {
            name: 'DATA for a stream never opened',
            send(tunnel) {
                tunnel.sendRaw(header(FrameType.DATA, tunnel.nextStreamId + 100, Uint8Array.of(0x16)));
            },
        },
    ]);
    return findings.outcome();
};
