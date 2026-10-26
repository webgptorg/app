import { TUNNEL_CLOSE_CODE, TUNNEL_SUBPROTOCOL } from '@ptbk/protocol';

import { Findings, fail } from '../../../src/check';
import type { CertificateMode } from '../../fake-relay/fake-relay';
import type { TunnelCheckRun } from './support';
import { delay, nextConnection, readyTunnel } from './support';

const BAD_CERTIFICATES: readonly CertificateMode[] = ['wrong-name', 'untrusted-ca', 'expired'];

export const websocketUpgrade: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const findings = new Findings();
    await runtime.manual(runtime.primary, ctx.signal, async (next) => {
        const connection = await nextConnection(next, runtime.timing.reconnectMs, 'after SHUTTING_DOWN');
        if (!connection.offeredProtocols.includes(TUNNEL_SUBPROTOCOL)) {
            findings.add(`the upgrade does not offer the ${TUNNEL_SUBPROTOCOL} subprotocol`);
        }
        await runtime.adopt(connection, ctx.signal);
    });
    const stray = runtime.relayIds.reduce((sum, relayId) => sum + runtime.relay.counters(relayId).strayRequests, 0);
    if (stray > 0)
        findings.add(`${String(stray)} requests reached the relay outside a WebSocket upgrade on TUNNEL_PATH`);
    return findings.outcome();
};

export const everyRelay: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const missing = await runtime.waitAllReady(runtime.timing.reconnectMs, ctx.signal);
    if (missing.length > 0) fail(`no ready tunnel to ${missing.join(', ')}`);
    // A second tunnel to the same relay would show up a moment after the first.
    await delay(runtime.timing.quietMs, ctx.signal);
    const findings = new Findings();
    for (const relayId of runtime.relayIds) {
        const open = runtime.openTunnels(relayId).length;
        if (open !== 1) findings.add(`${String(open)} tunnels are ready to ${relayId}, not one`);
    }
    const [first, stalled] = runtime.relayIds;
    if (findings.count > 0 || first === undefined || stalled === undefined) return findings.outcome();
    await runtime.manual(stalled, ctx.signal, async (next) => {
        const silent = await nextConnection(next, runtime.timing.reconnectMs, `to ${stalled} after SHUTTING_DOWN`);
        // The stalled relay never sends a challenge; another relay's tunnel must come back regardless.
        const before = performance.now();
        for (const tunnel of runtime.openTunnels(first)) tunnel.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        const back = await runtime.waitReady(first, runtime.timing.reconnectMs, ctx.signal, before);
        if (back === null)
            findings.add(`while ${stalled} stalled before its challenge, ${first} did not get ready again`);
        await runtime.adopt(silent, ctx.signal);
    });
    return findings.outcome();
};

export const relayCertificateVerified: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const relayId = runtime.primary;
    await readyTunnel(ctx);
    const findings = new Findings();
    try {
        for (const mode of BAD_CERTIFICATES) {
            runtime.relay.setCertificate(relayId, mode);
            const before = runtime.relay.counters(relayId);
            for (const tunnel of runtime.openTunnels(relayId)) tunnel.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
            const deadline = performance.now() + runtime.timing.reconnectMs;
            while (runtime.relay.counters(relayId).clientHellos === before.clientHellos) {
                if (performance.now() > deadline)
                    fail(`the engine did not dial ${relayId} again (${mode} certificate)`);
                await delay(50, ctx.signal);
            }
            // Every attempt within the window must stop at the certificate.
            await delay(runtime.timing.observeMs, ctx.signal);
            const after = runtime.relay.counters(relayId);
            if (after.upgrades > before.upgrades || after.strayRequests > before.strayRequests) {
                findings.add(`the engine sent HTTP to ${relayId} although it presented a ${mode} certificate`);
            }
        }
    } finally {
        runtime.relay.setCertificate(relayId, 'valid');
    }
    if ((await runtime.waitReady(relayId, runtime.timing.reconnectMs, ctx.signal)) === null) {
        findings.add(`no ready tunnel to ${relayId} once its certificate was valid again`);
    }
    return findings.outcome();
};
