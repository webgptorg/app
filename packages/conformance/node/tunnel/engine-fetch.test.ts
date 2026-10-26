import { Hostname, defaultHostname } from '@ptbk/protocol';
import type { EngineId } from '@ptbk/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FakeRelay } from '../fake-relay/fake-relay';
import { startFakeRelay } from '../fake-relay/fake-relay';
import { createTestCa } from '../pki/test-ca';
import type { FakeTunnelEngine } from '../testing/tunnel-fake-engine';
import { startFakeTunnelEngine } from '../testing/tunnel-fake-engine';
import { createTunnelFetch } from './engine-fetch';
import { CONTRACT_TIMING, TunnelRuntime } from './runtime';
import { relayIdsFor } from './tunnel-relay';

const ENGINE_DOMAIN = Hostname.parse('engine.localhost');

let relay: FakeRelay;
let engine: FakeTunnelEngine;
let runtime: TunnelRuntime;
let hostname: string;

beforeAll(async () => {
    const ca = createTestCa('fetch test CA', { permittedDomains: ['localhost'] });
    relay = await startFakeRelay({ relayIds: relayIdsFor(1), trustedCa: ca });
    runtime = new TunnelRuntime(relay, ENGINE_DOMAIN, CONTRACT_TIMING);
    engine = await startFakeTunnelEngine({
        relayUrls: relay.relayIds.map((relayId) => relay.url(relayId)),
        relayCaPem: ca.certPem,
        engineDomain: ENGINE_DOMAIN,
    });
    runtime.attach(engine);
    hostname = defaultHostname(engine.engineId as EngineId, ENGINE_DOMAIN);
});

afterAll(async () => {
    await engine.stop();
    await relay.close();
});

function tunnelFetch(certificateAuthority: () => Promise<string | null> = () => engine.certificateAuthority()) {
    return createTunnelFetch({
        hostname,
        tunnel: async () => {
            const tunnel = await runtime.waitReady(null, 5_000, AbortSignal.timeout(6_000));
            if (tunnel === null) throw new Error('no tunnel');
            return tunnel;
        },
        certificateAuthority,
        handshakeMs: 5_000,
    });
}

describe('fetch through the tunnel', () => {
    it('reaches the engine on its own origin, with and without a body', async () => {
        const fetch = tunnelFetch();
        const get = await fetch(`https://${hostname}/api/v1/engine`);
        expect(get.status).toBe(401);
        expect(get.headers.get('content-type')).toBe('application/problem+json');
        expect(await get.json()).toMatchObject({ code: 'unauthenticated' });
        const post = await fetch(`https://${hostname}/api/v1/agents`, { method: 'POST', body: '{"name":"x"}' });
        expect(post.status).toBe(401);
        await post.arrayBuffer();
    });

    it('streams no body for 204 and aborts a request that hangs', async () => {
        const fetch = tunnelFetch();
        const empty = await fetch(`https://${hostname}/__fake/no-content`);
        expect([empty.status, empty.body]).toEqual([204, null]);
        await expect(fetch(`https://${hostname}/__fake/hang`, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
    });

    it('refuses a certificate for another name', async () => {
        const ca = createTestCa('wrong-name test CA', { permittedDomains: ['localhost'] });
        const other = await startFakeRelay({ relayIds: relayIdsFor(1), trustedCa: ca });
        const otherRuntime = new TunnelRuntime(other, ENGINE_DOMAIN, CONTRACT_TIMING);
        const wrong = await startFakeTunnelEngine({
            relayUrls: other.relayIds.map((relayId) => other.url(relayId)),
            relayCaPem: ca.certPem,
            engineDomain: ENGINE_DOMAIN,
            defects: ['wrong-certificate-name'],
        });
        otherRuntime.attach(wrong);
        try {
            const wrongHost = defaultHostname(wrong.engineId as EngineId, ENGINE_DOMAIN);
            const fetch = createTunnelFetch({
                hostname: wrongHost,
                tunnel: async () => {
                    const tunnel = await otherRuntime.waitReady(null, 5_000, AbortSignal.timeout(6_000));
                    if (tunnel === null) throw new Error('no tunnel');
                    return tunnel;
                },
                certificateAuthority: () => wrong.certificateAuthority(),
                handshakeMs: 5_000,
            });
            await expect(fetch(`https://${wrongHost}/`)).rejects.toThrow('not valid for');
        } finally {
            await wrong.stop();
            await other.close();
        }
    });

    it('checks only name and dates without a trust anchor', async () => {
        const response = await tunnelFetch(() => Promise.resolve(null))(`https://${hostname}/`);
        expect(response.status).toBe(401);
        await response.arrayBuffer();
    });

    it('refuses another origin, another CA and an aborted request', async () => {
        const fetch = tunnelFetch();
        await expect(fetch('https://elsewhere.localhost/')).rejects.toThrow(TypeError);
        await expect(fetch(`https://${hostname}:8443/`)).rejects.toThrow(TypeError);
        const stranger = createTestCa('stranger CA');
        await expect(tunnelFetch(() => Promise.resolve(stranger.certPem))(`https://${hostname}/`)).rejects.toThrow(
            'TLS handshake failed',
        );
        await expect(fetch(`https://${hostname}/`, { signal: AbortSignal.abort() })).rejects.toThrow();
    });
});
