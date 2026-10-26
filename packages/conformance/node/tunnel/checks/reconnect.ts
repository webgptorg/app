import type { TunnelRejectReason } from '@ptbk/protocol';
import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';

import { Findings, fail } from '../../../src/check';
import type { RelayConnection } from '../../fake-relay/fake-relay';
import { awaitAuth, sendChallenge } from '../handshake';
import type { TunnelCheckContext, TunnelCheckRun } from './support';
import { closeWithin, collect, delay, readyTunnel } from './support';

/** Standard WebSocket close code after a `rate-limited` reject (C-02); not a `TUNNEL_CLOSE_CODE`. */
const WS_TRY_AGAIN_LATER = 1013;
const WS_INTERNAL_ERROR = 1011;
/** How long the relay stays down in the restart check. */
const RELAY_DOWN_MS = 1_000;

const REJECTS: readonly { readonly reason: TunnelRejectReason; readonly code: number }[] = [
    { reason: 'auth-failed', code: TUNNEL_CLOSE_CODE.AUTH_FAILED },
    { reason: 'suspended', code: TUNNEL_CLOSE_CODE.SUSPENDED },
    { reason: 'unsupported-version', code: TUNNEL_CLOSE_CODE.PROTOCOL_ERROR },
    { reason: 'timeout', code: TUNNEL_CLOSE_CODE.AUTH_FAILED },
    { reason: 'rate-limited', code: WS_TRY_AGAIN_LATER },
];

const AFTER_READY_CLOSES: readonly { readonly name: string; readonly code: number | null }[] = [
    { name: 'SHUTTING_DOWN', code: TUNNEL_CLOSE_CODE.SHUTTING_DOWN },
    { name: 'AUTH_FAILED', code: TUNNEL_CLOSE_CODE.AUTH_FAILED },
    { name: 'SUSPENDED', code: TUNNEL_CLOSE_CODE.SUSPENDED },
    { name: 'PROTOCOL_ERROR', code: TUNNEL_CLOSE_CODE.PROTOCOL_ERROR },
    { name: 'FRAME_BUDGET', code: TUNNEL_CLOSE_CODE.FRAME_BUDGET },
    { name: 'a lost connection (no close frame)', code: null },
];

/** Refuses `connection` the way a relay does: challenge, auth, then `reject` and the reason's close code. */
async function reject(
    ctx: TunnelCheckContext,
    connection: RelayConnection,
    reason: TunnelRejectReason,
    code: number,
    findings: Findings,
): Promise<void> {
    sendChallenge(connection);
    await awaitAuth(connection, ctx.runtime.timing.authMs, ctx.signal);
    connection.sendJson({ v: 1, type: 'reject', reason });
    connection.close(code);
    const after = await collect(connection, ctx.runtime.timing.closeMs, ctx.signal);
    if (after.some((event) => event.kind !== 'closed')) findings.add(`after a ${reason} reject the engine sent more`);
}

export const afterClose: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const findings = new Findings();
    for (const { name, code } of AFTER_READY_CLOSES) {
        const tunnel = await readyTunnel(ctx);
        const closedAt = performance.now();
        if (code === null) tunnel.terminate();
        else tunnel.close(code);
        const limit =
            code === TUNNEL_CLOSE_CODE.SHUTTING_DOWN ? runtime.timing.shuttingDownMs : runtime.timing.reconnectMs;
        const back = await runtime.waitReady(runtime.primary, limit, ctx.signal, closedAt);
        if (back === null) findings.add(`after ${name}, no ready tunnel within ${String(limit)} ms`);
    }
    return findings.outcome();
};

export const relayRestart: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const missing = await runtime.waitAllReady(runtime.timing.reconnectMs, ctx.signal);
    if (missing.length > 0) fail(`no ready tunnel to ${missing.join(', ')} before the restart`);
    const downAt = performance.now();
    runtime.relay.setAccepting(false);
    runtime.relay.terminateAll();
    try {
        await delay(RELAY_DOWN_MS, ctx.signal);
    } finally {
        runtime.relay.setAccepting(true);
    }
    const findings = new Findings();
    const backs = await Promise.all(
        runtime.relayIds.map(async (relayId) => ({
            relayId,
            tunnel: await runtime.waitReady(relayId, runtime.timing.relayRestartMs, ctx.signal, downAt),
        })),
    );
    for (const { relayId, tunnel } of backs) {
        if (tunnel === null) {
            findings.add(`${relayId} was not ready within ${String(runtime.timing.relayRestartMs)} ms of coming back`);
        }
    }
    return findings.outcome();
};

export const afterReject: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const findings = new Findings();
    await runtime.manual(runtime.primary, ctx.signal, async (next) => {
        let connection = await next(runtime.timing.reconnectMs);
        if (connection === null) fail('the engine did not reconnect after SHUTTING_DOWN');
        for (const { reason, code } of REJECTS) {
            await reject(ctx, connection, reason, code, findings);
            const again = await next(runtime.timing.reconnectMs);
            if (again === null) {
                findings.add(`no reconnect within ${String(runtime.timing.reconnectMs)} ms after a ${reason} reject`);
                return;
            }
            connection = again;
        }
        await runtime.adopt(connection, ctx.signal);
    });
    return findings.outcome();
};

/** Ways an attempt fails before `ready`; each must count towards the engine's backoff. */
const FAILURES: readonly ((
    ctx: TunnelCheckContext,
    connection: RelayConnection,
    findings: Findings,
) => Promise<void>)[] = [
    (ctx, connection, findings) => reject(ctx, connection, 'rate-limited', WS_TRY_AGAIN_LATER, findings),
    (_ctx, connection) => {
        connection.close(WS_INTERNAL_ERROR);
        return Promise.resolve();
    },
    (ctx, connection, findings) => reject(ctx, connection, 'auth-failed', TUNNEL_CLOSE_CODE.AUTH_FAILED, findings),
    (_ctx, connection) => {
        connection.terminate();
        return Promise.resolve();
    },
    (ctx, connection, findings) => reject(ctx, connection, 'rate-limited', WS_TRY_AGAIN_LATER, findings),
];

/**
 * The engine's own delays: from the moment a failed attempt's connection closed to the next TCP connection. The
 * relay's handshake work is not in them, so a slow or busy machine only lengthens what a correct engine shows, and a
 * tight loop stays near zero.
 */
export const backoff: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const findings = new Findings();
    const delays: number[] = [];
    await runtime.manual(runtime.primary, ctx.signal, async (next) => {
        let closedAt: number | null = null;
        for (const failAttempt of [...FAILURES, null]) {
            const connection = await next(runtime.timing.reconnectMs);
            if (connection === null)
                fail(`the engine stopped reconnecting after ${String(delays.length + 1)} failed attempts`);
            if (closedAt !== null) delays.push(Math.max(0, Math.round(connection.connectedAt - closedAt)));
            if (failAttempt === null) {
                await runtime.adopt(connection, ctx.signal);
                return;
            }
            await failAttempt(ctx, connection, findings);
            if ((await closeWithin(connection, runtime.timing.closeMs)).kind === 'open') connection.terminate();
            closedAt = (await connection.closed).at;
        }
    });
    const spread = delays.reduce((sum, delay) => sum + delay, 0);
    if (spread < runtime.timing.minBackoffSpreadMs) {
        findings.add(
            `after ${String(delays.length)} failed attempts the engine waited ${String(spread)} ms in all ` +
                `(${delays.join(', ')} ms) before reconnecting: no backoff`,
        );
    }
    return findings.outcome();
};

export const replacedNoLoop: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const tunnel = await readyTunnel(ctx);
    let reconnects = 0;
    await runtime.manual(
        runtime.primary,
        ctx.signal,
        async (next) => {
            tunnel.close(TUNNEL_CLOSE_CODE.REPLACED);
            const deadline = performance.now() + runtime.timing.replacedObserveMs;
            for (;;) {
                const left = deadline - performance.now();
                if (left <= 0) return;
                const connection = await next(left);
                if (connection === null) return;
                reconnects++;
                // Another holder of the key took the slot again: what a loop would look like from the relay.
                const again = await runtime.adopt(connection, ctx.signal);
                again?.close(TUNNEL_CLOSE_CODE.REPLACED);
            }
        },
        { keepTunnels: true, awaitReady: false },
    );
    const restartedAt = await runtime.restartEngine(undefined, ctx.signal);
    const findings = new Findings();
    if (reconnects > 1) {
        findings.add(
            `the engine reconnected ${String(reconnects)} times within ${String(runtime.timing.replacedObserveMs)} ms of REPLACED`,
        );
    }
    const missing = await runtime.waitAllReady(runtime.timing.reconnectMs, ctx.signal, restartedAt);
    if (missing.length > 0) findings.add(`after a restart, no ready tunnel to ${missing.join(', ')}`);
    return findings.outcome();
};
