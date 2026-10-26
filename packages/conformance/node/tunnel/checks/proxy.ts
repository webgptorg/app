import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';

import { Findings, fail } from '../../../src/check';
import { startConnectProxy } from '../../fake-relay/connect-proxy';
import type { TunnelCheckRun } from './support';
import { delay } from './support';

/** Test credentials for the in-process proxy; they protect nothing and must never show up in the engine's logs. */
const PROXY_USER = 'conformance';
const PROXY_PASSWORD = 'conformance-proxy-password';

export const proxyConnect: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const { port } = runtime.relay;
    const [proxied, direct] = runtime.relayIds;
    if (proxied === undefined) fail('no relay');
    const proxy = await startConnectProxy({
        allowedTargets: runtime.relayIds.map((relayId) => `${relayId}:${String(port)}`),
        upstreamHost: runtime.relay.host,
        credentials: { username: PROXY_USER, password: PROXY_PASSWORD },
    });
    const findings = new Findings();
    let directSince: number;
    try {
        const proxiedSince = await runtime.restartEngine(
            { HTTPS_PROXY: proxy.url, NO_PROXY: direct ?? null },
            ctx.signal,
        );
        const missing = await runtime.waitAllReady(runtime.timing.reconnectMs, ctx.signal, proxiedSince);
        if (missing.length > 0) findings.add(`with HTTPS_PROXY set, no ready tunnel to ${missing.join(', ')}`);
        const through = (relayId: string): boolean =>
            proxy.requests.some((request) => request.target === `${relayId}:${String(port)}` && request.status === 200);
        if (!through(proxied))
            findings.add(`the tunnel to ${proxied} did not go through the proxy with its credentials`);
        if (proxy.requests.some((request) => request.status === 407))
            findings.add('a CONNECT came without the proxy credentials');
        if (direct !== undefined && through(direct))
            findings.add(`${direct} is in NO_PROXY but went through the proxy`);

        runtime.relay.setCertificate(proxied, 'wrong-name');
        try {
            const before = runtime.relay.counters(proxied);
            for (const tunnel of runtime.openTunnels(proxied)) tunnel.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
            await delay(runtime.timing.observeMs, ctx.signal);
            const after = runtime.relay.counters(proxied);
            if (after.clientHellos === before.clientHellos)
                findings.add('the engine did not dial again through the proxy');
            if (after.upgrades > before.upgrades) {
                findings.add(
                    'through the proxy, the engine upgraded although the relay certificate names another host',
                );
            }
        } finally {
            runtime.relay.setCertificate(proxied, 'valid');
        }
        if (runtime.engine.logs().includes(PROXY_PASSWORD)) findings.add('the engine logged the proxy password');
    } finally {
        directSince = await runtime.restartEngine({ HTTPS_PROXY: null, NO_PROXY: null }, ctx.signal).catch(() => 0);
        await proxy.close();
    }
    const missing = await runtime.waitAllReady(runtime.timing.reconnectMs, ctx.signal, directSince);
    if (missing.length > 0) findings.add(`without the proxy again, no ready tunnel to ${missing.join(', ')}`);
    return findings.outcome();
};
