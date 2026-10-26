import type * as tls from 'node:tls';

import { ENGINE_API_PREFIX } from '@ptbk/engine-api';
import { CLOSE_CODE, FrameType, INITIAL_WINDOW_BYTES } from '@ptbk/protocol';

import { Findings, PASS, fail } from '../../../src/check';
import type { RelayStream, RelayTunnel } from '../../fake-relay/relay-tunnel';
import { readResponses, requestBytes } from '../http1';
import type { ResponsesRead } from '../http1';
import { certificateProblem, engineAnswerProblem, engineHostname, getEngine } from '../through-stream';
import type { TunnelCheckContext, TunnelCheckRun } from './support';
import { delay, ownerSession, readyTunnel, tlsToEngine } from './support';

const CONCURRENT_STREAMS = 24;
/** How far past the initial window the flow-control checks push, so at least one grant is needed. */
const WINDOWS_OF_TRAFFIC = 2.5;
const PADDING_BYTES = 2_000;
const BATCH_REQUESTS = 40;
/** Deep pipelining is not what these checks are about; servers may cap it. */
const MAX_PIPELINED = 400;

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
        host: engineHostname(tunnel, ctx.runtime.engine.engineDomain),
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
    const hostname = engineHostname(tunnel, ctx.runtime.engine.engineDomain);
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
    const unknown = `conformance-unknown.${ctx.runtime.engine.engineDomain}`;
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
    const hostname = engineHostname(tunnel, ctx.runtime.engine.engineDomain);
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

/** DATA bytes one `GET /engine` costs on the wire, measured on `socket`. */
async function responseCost(
    ctx: TunnelCheckContext,
    tunnel: RelayTunnel,
    { socket, stream }: Connected,
): Promise<number> {
    const before = stream.receivedBytes;
    const reading = readResponses(socket, 1, ctx.runtime.timing.requestMs);
    socket.write(engineRequest(ctx, tunnel));
    const read = await reading;
    if (read.kind === 'failed') fail(`GET /api/v1/engine through the stream: ${read.reason}`);
    return Math.max(1, stream.receivedBytes - before);
}

function pipelineCount(cost: number): number {
    return Math.min(MAX_PIPELINED, Math.ceil((WINDOWS_OF_TRAFFIC * INITIAL_WINDOW_BYTES) / cost) + 1);
}

/**
 * Pipelines enough requests that their answers exceed the window several times, without granting credit. Leaves the
 * engine stalled at its credit and returns the pending reader.
 */
async function stallAtWindow(
    ctx: TunnelCheckContext,
    tunnel: RelayTunnel,
    connected: Connected,
): Promise<{ readonly count: number; readonly reading: Promise<ResponsesRead> }> {
    const { timing } = ctx.runtime;
    const count = pipelineCount(await responseCost(ctx, tunnel, connected));
    const reading = readResponses(connected.socket, count, timing.requestMs * 4);
    const request = engineRequest(ctx, tunnel);
    connected.socket.write(Buffer.concat(Array.from({ length: count }, () => request)));
    await quiet(connected.stream, timing.quietMs, timing.requestMs, ctx.signal);
    return { count, reading };
}

export const sendWindow: TunnelCheckRun = async (ctx) => {
    const tunnel = await readyTunnel(ctx);
    const connected = await tlsOrFail(ctx, tunnel, false);
    const { socket, stream } = connected;
    const findings = new Findings();
    try {
        const { count, reading } = await stallAtWindow(ctx, tunnel, connected);
        if (stream.overrunBytes > 0) {
            findings.add(`the engine sent ${String(stream.overrunBytes)} DATA bytes beyond the credit it had`);
        }
        stream.grant(64 * INITIAL_WINDOW_BYTES);
        const read = await reading;
        if (read.kind === 'failed') {
            findings.add(
                `after WINDOW, ${String(read.responses.length)} of ${String(count)} answers arrived: ${read.reason}`,
            );
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
        const request = engineRequest(ctx, tunnel, { 'X-Conformance-Padding': 'p'.repeat(PADDING_BYTES) });
        // Batches, each answered before the next, keep pipelining shallow; together they exceed the initial window,
        // so they only get through if the engine grants credit as it reads.
        const batches = Math.ceil((WINDOWS_OF_TRAFFIC * INITIAL_WINDOW_BYTES) / (request.length * BATCH_REQUESTS));
        for (let batch = 0; batch < batches; batch++) {
            const reading = readResponses(socket, BATCH_REQUESTS, ctx.runtime.timing.requestMs);
            socket.write(Buffer.concat(Array.from({ length: BATCH_REQUESTS }, () => request)));
            const read = await reading;
            if (read.kind === 'failed') {
                const sent = (batch * BATCH_REQUESTS + read.responses.length) * request.length;
                fail(
                    `after ${String(sent)} bytes, the next answers did not come (${read.reason}); ` +
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
        const reading = readResponses(ending.socket, 1, timing.requestMs);
        ending.socket.write(engineRequest(ctx, tunnel, { Connection: 'close' }));
        const read = await reading;
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

export const ping: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const { pingMs } = runtime.timing;
    for (;;) {
        const tunnels = runtime.relayIds.flatMap((relayId) => runtime.openTunnels(relayId));
        const oldest = tunnels.sort((a, b) => a.readyAt - b.readyAt)[0] ?? (await readyTunnel(ctx));
        const age = performance.now() - oldest.readyAt;
        if (age < pingMs) {
            await Promise.race([oldest.closed, delay(pingMs - age, ctx.signal)]);
            if (!oldest.isOpen()) continue;
        }
        const pings = oldest.connection.pings.filter((at) => at >= oldest.connection.openedAt);
        const marks = [oldest.readyAt, ...pings.filter((at) => at > oldest.readyAt), performance.now()];
        const gaps = marks.slice(1).map((at, index) => at - (marks[index] ?? at));
        const longest = Math.max(...gaps);
        if (pings.length === 0) fail(`no WebSocket ping in ${String(Math.round(age))} ms on a ready tunnel`);
        if (longest > pingMs) fail(`${String(Math.round(longest))} ms passed without a WebSocket ping`);
        return PASS;
    }
};
