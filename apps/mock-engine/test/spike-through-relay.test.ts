import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { connect } from 'node:tls';

import type { EngineId } from '@ptbk/protocol';
import { EngineVersion, Hostname, RelayId, defaultHostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createDevCa, createDevCaCertificateSource } from '../src/adapters/dev-ca';
import { createMemoryIdentityStore } from '../src/adapters/memory-identity-store';
import { createWsRelayDialer } from '../src/adapters/ws-relay-dialer';
import type { MockEngineConfig } from '../src/app/config';
import { startMockEngine } from '../src/app/start-mock-engine';
import { createFakeClock } from '../src/testing/fake-clock';
import { startFakePassthrough } from '../src/testing/fake-passthrough';
import { startFakeRelay } from '../src/testing/fake-relay';
import { createMemoryLogger } from '../src/testing/memory-logger';
import { createSeededRandom } from '../src/testing/seeded-random';
import { lookupLoopback, trackLinkStates } from '../src/testing/test-hosts';
import { createTestCa } from '../src/testing/test-pki';
import { DEFAULT_MOCK_SETTINGS } from '../src/testing/mock-settings';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const CUSTOMER_DOMAIN = Hostname.parse('customer.test');
const CUSTOM_HOSTNAME = Hostname.parse('agents.customer.test');
const RELAY = RelayId.parse('relay-a.ptbk.test');
const relayCa = createTestCa('M-02 relay CA');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
    const identityStore = createMemoryIdentityStore();
    const identity = await identityStore.loadOrCreate();
    const hostname = defaultHostname(identity.engineId, ENGINE_DOMAIN);
    // The relay confirms a custom hostname as well, so the engine must hold a certificate for it too.
    const registry = (engineId: EngineId) =>
        engineId === identity.engineId
            ? { publicKey: identity.publicKey, hostnames: [hostname, CUSTOM_HOSTNAME] }
            : undefined;
    const relay = await startFakeRelay({ relayId: RELAY, tls: relayCa.issue([RELAY]), registry });
    cleanups.push(() => relay.close());

    const clock = createFakeClock(Date.now());
    const logger = createMemoryLogger();
    const devCa = createDevCa([ENGINE_DOMAIN, CUSTOMER_DOMAIN], clock);
    const states = trackLinkStates();
    const config: MockEngineConfig = {
        mode: 'tunnel',
        dataDir: '/unused',
        relays: [{ url: relay.url, relayId: RELAY, port: relay.port }],
        engineDomain: ENGINE_DOMAIN,
        engineVersion: EngineVersion.parse('0.1.0'),
        proxy: null,
        extraCaFile: null,
        devCaFiles: null,
        devCaDomains: [CUSTOMER_DOMAIN],
        logLevel: 'info',
        ...DEFAULT_MOCK_SETTINGS,
    };
    const engine = await startMockEngine(config, {
        logger,
        clock,
        random: createSeededRandom(3),
        identityStore,
        dialer: createWsRelayDialer({ clock, proxy: null, ca: [relayCa.certPem], lookup: lookupLoopback }),
        certificates: createDevCaCertificateSource({ ca: devCa, clock, logger }),
        onLinkState: states.onLinkState,
    });
    cleanups.push(() => engine.close());
    await states.next(RELAY, 'ready');
    const passthrough = await startFakePassthrough(await relay.waitForSession());
    cleanups.push(() => passthrough.close());
    return { identity, hostname, devCa, passthrough, logger };
}

function get(
    url: string,
    ca: string,
    encoding: BufferEncoding = 'utf8',
): Promise<{ readonly response: IncomingMessage; readonly body: string }> {
    return new Promise((resolve, reject) => {
        // ALPN as curl offers it; Node's client offers none by default.
        const options = { ca, lookup: lookupLoopback, agent: false, ALPNProtocols: ['http/1.1'] };
        const outgoing = request(url, options, (response) => {
            let body = '';
            response.setEncoding(encoding).on('data', (chunk: string) => (body += chunk));
            response.once('end', () => {
                resolve({ response, body });
            });
        });
        outgoing.once('error', reject);
        outgoing.end();
    });
}

describe('spike endpoints through an in-test relay (C-02 tunnel plus an SNI passthrough)', () => {
    it('answers https://<engineId>.<domain>/__spike/whoami with the engine certificate and the client IP', async () => {
        const ctx = await setup();
        const { response, body } = await get(
            `https://${ctx.hostname}:${String(ctx.passthrough.port)}/__spike/whoami`,
            ctx.devCa.certificatePem,
        );
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(body)).toEqual({
            engineId: ctx.identity.engineId,
            hostname: ctx.hostname,
            clientIp: '127.0.0.1',
            alpn: 'http/1.1',
            tlsVersion: 'TLSv1.3',
        });
    });

    it('serves a hostname the relay confirmed in ready, and the peer certificate is the dev CA leaf, not the relay', async () => {
        const ctx = await setup();
        const socket = connect({
            host: '127.0.0.1',
            port: ctx.passthrough.port,
            servername: CUSTOM_HOSTNAME,
            ca: ctx.devCa.certificatePem,
        });
        await once(socket, 'secureConnect');
        const peer = socket.getPeerX509Certificate();
        expect(peer?.subjectAltName).toBe(`DNS:${ctx.hostname}, DNS:${CUSTOM_HOSTNAME}`);
        expect(peer?.checkIssued(ctx.devCa.certificate)).toBe(true);
        socket.destroy();

        const { response } = await get(
            `https://${CUSTOM_HOSTNAME}:${String(ctx.passthrough.port)}/__spike/`,
            ctx.devCa.certificatePem,
        );
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    });

    it('streams a download several tunnel windows long, byte for byte', async () => {
        const ctx = await setup();
        const bytes = 3 * 1024 * 1024 + 7;
        const { response, body } = await get(
            `https://${ctx.hostname}:${String(ctx.passthrough.port)}/__spike/download?bytes=${String(bytes)}`,
            ctx.devCa.certificatePem,
            'latin1',
        );
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-length']).toBe(String(bytes));
        expect(body.length).toBe(bytes);
    });

    it('never logs key material', async () => {
        const ctx = await setup();
        await get(`https://${ctx.hostname}:${String(ctx.passthrough.port)}/__spike/whoami`, ctx.devCa.certificatePem);
        expect(JSON.stringify(ctx.logger.entries)).not.toContain('PRIVATE KEY');
        expect(ctx.logger.entries.some((entry) => entry.event === 'tls.certificate-issued')).toBe(true);
    });
});
