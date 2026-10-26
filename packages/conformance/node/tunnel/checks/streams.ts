import type * as tls from 'node:tls';

import { ENGINE_API_PREFIX } from '@ptbk/engine-api';
import { CLOSE_CODE, FrameType, INITIAL_WINDOW_BYTES } from '@ptbk/protocol';

import { Findings, PASS, fail } from '../../../src/check';
import type { RelayStream, RelayTunnel } from '../../fake-relay/relay-tunnel';
import { ResponseReader, requestBytes } from '../http1';
import { certificateProblem, engineAnswerProblem, engineHostname, getEngine } from '../through-stream';
import type { TunnelCheckContext, TunnelCheckRun } from './support';
import { delay, ownerSession, readyTunnel, tlsToEngine } from './support';

const CONCURRENT_STREAMS = 24;
/** How far past the initial window the flow-control checks push, so at least one grant is needed. */
const WINDOWS_OF_TRAFFIC = 2.5;
/** Below the 8 KiB a header line may take on common servers. */
const PADDING_BYTES = 4_000;
/** Answers of 64 bytes would fill the window this many times over; more means the window was ignored. */
const MAX_SEQUENTIAL = Math.ceil((2 * INITIAL_WINDOW_BYTES) / 64);

interface Connected {
    readonly socket: tls.TLSSocket;
    readonly stream: RelayStream;
}

async function tlsOrFail(ctx: TunnelCheckContext, tunnel: RelayTunnel, autoGrant = true): Promise<Connected> {
    const result = await tlsToEngine(ctx, tunnel, { stream: { autoGrant } });
    if (result.kind === 'failed') fail(`TLS through a stream to the default hostname: ${result.reason}`);
    return { socket: result.socket, stream: result.stream };
}

function engineRequest(ctx: TunnelCheckContext, tunnel: RelayTunnel, extra: Record<string, string> = {}): Buffer {
    return requestBytes({
        host: engineHostname(tunnel, ctx.runtime.engineDomain),
        path: `${ENGINE_API_PREFIX}/engine`,
        headers: extra,
    });
}

/** Resolves once no DATA arrived on `stream` for `quietMs`, or after `maxMs`. */
async function quiet(stream: RelayStream, quietMs: number, maxMs: number, signal: AbortSignal): Promise<void> {
    const deadline = performance.now() + maxMs;
    for (;;) {
        const last = stream.dataLog.at(-1)?.at ?? stream.openedAt;
        const now = performance.now();
        if (now - last >= quietMs || now >= deadline) return;
        await delay(Math.min(quietMs - (now - last), deadline - now), signal);
    }
}

export const tlsThroughTunnel: TunnelCheckRun = async (ctx) => {
    const tunnel = await readyTunnel(ctx);
    const hostname = engineHostname(tunnel, ctx.runtime.engineDomain);
    const result = await tlsToEngine(ctx, tunnel);
    if (result.kind === 'failed') fail(`TLS through a stream with SNI ${hostname}: ${result.reason}`);
    const findings = new Findings();
    try {
        if (result.protocol !== 'TLSv1.3')
            findings.add(`the engine negotiated ${String(result.protocol)}, not TLS 1.3`);
        const problem = certificateProblem(result.certificate, hostname);
        if (problem !== null) findings.add(problem);
        const credential = await ownerSession(ctx);
        const answer = await getEngine(result.socket, hostname, credential, ctx.runtime.timing.requestMs);
        if (answer.kind === 'failed') findings.add(`GET /api/v1/engine through the stream: ${answer.reason}`);
        else {
            const wrong = engineAnswerProblem(answer.response, tunnel.auth.engineId, credential !== null);
            if (wrong !== null) findings.add(wrong);
        }
    } finally {
        result.socket.destroy();
    }
    for (const problem of tunnel.problems) findings.add(problem);
    return findings.outcome();
};

export const unknownSniRefused: TunnelCheckRun = async (ctx) => {
    const tunnel = await readyTunnel(ctx);
    const findings = new Findings();
    const unknown = `conformance-unknown.${ctx.runtime.engineDomain}`;
    for (const [what, servername] of [
        [`SNI ${unknown}`, unknown],
        ['no SNI', null],
    ] as const) {
        // No trust anchor: any certificate at all is the failure.
        const result = await tlsToEngine(ctx, tunnel, { servername, certificateAuthorityPem: null });
        if (result.kind === 'ok') {
            findings.add(`a ClientHello with ${what} got a certificate`);
            result.socket.destroy();
        }
    }
    if (!tunnel.isOpen()) findings.add('the engine closed the whole tunnel over one refused TLS handshake');
    return findings.outcome();
};

export const concurrentStreams: TunnelCheckRun = async (ctx) => {
    const tunnel = await readyTunnel(ctx);
    const hostname = engineHostname(tunnel, ctx.runtime.engineDomain);
    const credential = await ownerSession(ctx);
    const outcomes = await Promise.all(
        Array.from({ length: CONCURRENT_STREAMS }, async () => {
            const result = await tlsToEngine(ctx, tunnel);
            if (result.kind === 'failed') return result.reason;
            try {
                const answer = await getEngine(result.socket, hostname, credential, ctx.runtime.timing.requestMs);
                if (answer.kind === 'failed') return answer.reason;
                return engineAnswerProblem(answer.response, tunnel.auth.engineId, credential !== null);
            } finally {
                result.socket.destroy();
            }
        }),
    );
    const failed = outcomes.filter((outcome): outcome is string => outcome !== null);
    if (failed.length > 0) {
        fail(
            `${String(failed.length)} of ${String(CONCURRENT_STREAMS)} concurrent streams failed: ${[...new Set(failed)].join('; ')}`,
        );
    }
    return PASS;
};

interface Stalled {
    readonly reader: ResponseReader;
    /** Answers that arrived before the engine ran out of credit. */
    readonly answered: number;
}

/**
 * Sends requests one after another on one connection, as a browser would (no pipelining), without granting credit,
 * until an answer stops arriving: the engine is then out of credit, with that answer half sent. Fails when the
 * engine keeps answering far past its window, which only an engine ignoring the window can.
 */
async function stallAtWindow(ctx: TunnelCheckContext, tunnel: RelayTunnel, connected: Connected): Promise<Stalled> {
    const { timing } = ctx.runtime;
    const reader = new ResponseReader(connected.socket);
    const request = engineRequest(ctx, tunnel);
    for (let answered = 0; answered < MAX_SEQUENTIAL; answered++) {
        connected.socket.write(request);
        const read = await reader.next(timing.quietMs * 2);
        if (read.kind === 'failed') {
            if (!read.timedOut) fail(`GET /api/v1/engine through the stream: ${read.reason}`);
            await quiet(connected.stream, timing.quietMs, timing.requestMs, ctx.signal);
            return { reader, answered };
        }
        if (connected.stream.overrunBytes > 0) return { reader, answered };
    }
    return { reader, answered: MAX_SEQUENTIAL };
}

export const sendWindow: TunnelCheckRun = async (ctx) => {
    const tunnel = await readyTunnel(ctx);
    const connected = await tlsOrFail(ctx, tunnel, false);
    const { socket, stream } = connected;
    const findings = new Findings();
    try {
        const { reader } = await stallAtWindow(ctx, tunnel, connected);
        if (stream.overrunBytes > 0) {
            findings.add(`the engine sent ${String(stream.overrunBytes)} DATA bytes beyond the credit it had`);
        } else {
            stream.grant(INITIAL_WINDOW_BYTES);
            const read = await reader.next(ctx.runtime.timing.requestMs);
            if (read.kind === 'failed')
                findings.add(`after WINDOW, the half-sent answer did not complete: ${read.reason}`);
        }
    } finally {
        socket.destroy();
    }
    for (const problem of tunnel.problems) findings.add(problem);
    return findings.outcome();
};

export const grantsCredit: TunnelCheckRun = async (ctx) => {
    const tunnel = await readyTunnel(ctx);
    const { socket, stream } = await tlsOrFail(ctx, tunnel);
    try {
        const reader = new ResponseReader(socket);
        const request = engineRequest(ctx, tunnel, { 'X-Conformance-Padding': 'p'.repeat(PADDING_BYTES) });
        // Together more than the initial window: they only get through if the engine grants credit as it reads.
        const count = Math.ceil((WINDOWS_OF_TRAFFIC * INITIAL_WINDOW_BYTES) / request.length);
        for (let sent = 0; sent < count; sent++) {
            socket.write(request);
            const read = await reader.next(ctx.runtime.timing.requestMs);
            if (read.kind === 'failed') {
                fail(
                    `after ${String(sent * request.length)} bytes, the next answer did not come (${read.reason}); ` +
                        `${String(stream.sendCredit())} bytes of credit were left`,
                );
            }
        }
        return PASS;
    } finally {
        socket.destroy();
    }
};

export const closeHandling: TunnelCheckRun = async (ctx) => {
    const tunnel = await readyTunnel(ctx);
    const { timing } = ctx.runtime;
    const findings = new Findings();

    const ending = await tlsOrFail(ctx, tunnel);
    try {
        const reader = new ResponseReader(ending.socket);
        ending.socket.write(engineRequest(ctx, tunnel, { Connection: 'close' }));
        const read = await reader.next(timing.requestMs);
        if (read.kind === 'failed') findings.add(`GET with Connection: close: ${read.reason}`);
        const closed = await Promise.race([
            ending.stream.engineClosed,
            delay(timing.closeMs, ctx.signal).then(() => null),
        ]);
        if (closed === null) findings.add('the engine sent no CLOSE after ending a connection (Connection: close)');
    } finally {
        ending.socket.destroy();
    }

    const stalled = await tlsOrFail(ctx, tunnel, false);
    const { stream } = stalled;
    try {
        await stallAtWindow(ctx, tunnel, stalled);
        stream.closeFromRelay(CLOSE_CODE.NORMAL);
        const closedAt = performance.now();
        // A late WINDOW for the closed stream: the engine must drop it, not resume sending, nor fail the tunnel.
        tunnel.sendFrame({ type: FrameType.WINDOW, streamId: stream.id, increment: INITIAL_WINDOW_BYTES });
        await delay(timing.observeMs, ctx.signal);
        const late = stream.dataLog.filter((record) => record.at > closedAt).reduce((sum, r) => sum + r.bytes, 0);
        if (late > 0) findings.add(`the engine sent ${String(late)} DATA bytes on a stream after the relay closed it`);
        if (!tunnel.isOpen()) findings.add('the engine closed the tunnel over a late WINDOW for a closed stream');
    } finally {
        stalled.socket.destroy();
    }
    for (const problem of tunnel.problems) findings.add(problem);
    return findings.outcome();
};

/**
 * Only the first interval: a second one would double the wait (25 s more) for little; an engine that pings once on
 * a timer pings again on it.
 */
export const ping: TunnelCheckRun = async (ctx) => {
    const { pingMs } = ctx.runtime.timing;
    const tunnel = await readyTunnel(ctx);
    const deadline = tunnel.readyAt + pingMs;
    // Pings before `ready` count from the WebSocket's opening; what matters is the first one after `ready`.
    const first = (): number | undefined => tunnel.connection.pings.find((at) => at > tunnel.readyAt);
    while (first() === undefined && performance.now() < deadline && tunnel.isOpen()) {
        await delay(Math.min(250, Math.max(1, deadline - performance.now())), ctx.signal);
    }
    const at = first();
    if (at === undefined || at > deadline) {
        fail(
            tunnel.isOpen()
                ? `no WebSocket ping within ${String(pingMs)} ms of ready`
                : 'the tunnel closed while the suite waited for a ping',
        );
    }
    return PASS;
};
