import type { TunnelRejectReason } from '@ptbk/protocol';
import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';

import { Findings, fail, skip } from '../../../src/check';
import type { RelayConnection } from '../../fake-relay/fake-relay';
import { awaitAuth, sendChallenge } from '../handshake';
import type { TunnelCheckContext, TunnelCheckRun } from './support';
import { collect, delay, readyTunnel } from './support';

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
    ctx.runtime.disrupted();
}

export const afterClose: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    await runtime.calm(ctx.signal);
    const findings = new Findings();
    for (const { name, code } of AFTER_READY_CLOSES) {
        const tunnel = await readyTunnel(ctx);
        const closedAt = performance.now();
        if (code === null) tunnel.terminate();
        else tunnel.close(code);
        const limit =
            code === TUNNEL_CLOSE_CODE.SHUTTING_DOWN ? runtime.timing.shuttingDownMs : runtime.timing.reconnectMs;
        const back = await runtime.waitReady(runtime.primary, limit, ctx.signal, closedAt);
        if (code !== TUNNEL_CLOSE_CODE.SHUTTING_DOWN) runtime.disrupted();
        if (back === null) findings.add(`after ${name}, no ready tunnel within ${String(limit)} ms`);
    }
    return findings.outcome();
};

export const relayRestart: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    await runtime.calm(ctx.signal);
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
    runtime.disrupted();
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
    await runtime.calm(ctx.signal);
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

export const backoff: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    await runtime.calm(ctx.signal);
    const findings = new Findings();
    const attempts: number[] = [];
    await runtime.manual(runtime.primary, ctx.signal, async (next) => {
        for (const failAttempt of FAILURES) {
            const connection = await next(runtime.timing.reconnectMs);
            if (connection === null)
                fail(`the engine stopped reconnecting after ${String(attempts.length)} failed attempts`);
            attempts.push(connection.openedAt);
            await failAttempt(ctx, connection, findings);
            runtime.disrupted();
        }
        const last = await next(runtime.timing.reconnectMs);
        if (last === null) fail(`the engine stopped reconnecting after ${String(attempts.length)} failed attempts`);
        attempts.push(last.openedAt);
        await runtime.adopt(last, ctx.signal);
    });
    const intervals = attempts.slice(1).map((at, index) => Math.round(at - (attempts[index] ?? at)));
    const spread = intervals.reduce((sum, interval) => sum + interval, 0);
    if (spread < runtime.timing.minBackoffSpreadMs) {
        findings.add(
            `${String(intervals.length)} reconnects after failed attempts came within ${String(spread)} ms ` +
                `(${intervals.join(', ')} ms): no backoff`,
        );
    }
    return findings.outcome();
};

export const replacedNoLoop: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    if (runtime.engine.restart === undefined) {
        skip('the engine would stay without a tunnel to this relay afterwards; needs a harness that can restart it');
    }
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
    await runtime.restartEngine(undefined, ctx.signal);
    const findings = new Findings();
    if (reconnects > 1) {
        findings.add(
            `the engine reconnected ${String(reconnects)} times within ${String(runtime.timing.replacedObserveMs)} ms of REPLACED`,
        );
    }
    const missing = await runtime.waitAllReady(runtime.timing.reconnectMs, ctx.signal);
    if (missing.length > 0) findings.add(`after a restart, no ready tunnel to ${missing.join(', ')}`);
    return findings.outcome();
};
