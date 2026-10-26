import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { Server, Socket, connect as connectTcp } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import { connect } from 'node:tls';

import { TUNNEL_PATH } from '@ptbk/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createSessionTable } from '../domain/tunnel/session-table';
import { createTunnelEndpoint } from '../domain/tunnel/tunnel-endpoint';
import type { TunnelSession } from '../domain/tunnel/tunnel-session';
import { ENGINE_DOMAIN } from '../testing/engines';
import { createFakeRandom } from '../testing/fake-random';
import { RELAY_ID } from '../testing/relay-harness';
import { createTestCertificate } from '../testing/test-pki';
import { createTestDeps } from '../testing/test-deps';
import { TEST_SESSION_LIMITS, testWsTunnelOptions, uncached } from '../testing/tunnel-options';
import { createMemoryMetrics } from '../testing/memory-metrics';
import { createMemoryLogger } from './memory-logger';
import { createMetricsEndpoint } from './metrics-endpoint';
import type { OwnTlsServer } from './own-tls-server';
import { CLOSE_GRACE_MS, RELAY_TLS_CIPHERS, clientIp, createOwnTlsServer } from './own-tls-server';
import { createFakeClock } from './fake-clock';
import { systemClock } from './system-clock';

type Handshake =
    { readonly ok: true; readonly protocol: string | null; readonly cipher: string } | { readonly ok: false };

const METRICS_TOKEN = `ptbk_mt_${'k'.repeat(43)}`;
const METRICS_BODY = '# TYPE ptbk_relay_tunnels_active gauge\nptbk_relay_tunnels_active 0\n';

// An RSA certificate, so a client can offer static-RSA and DHE-RSA suites that the relay must refuse by policy.
const certificate = createTestCertificate([RELAY_ID], 'rsa');

const IMAGE_DIGEST = `sha256:${'ab'.repeat(32)}`;

interface Answer {
    readonly status: number;
    readonly body: string;
    readonly image: string | undefined;
}

function getFrom(port: number, path: string, headers: Record<string, string> = {}): Promise<Answer> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            { host: '127.0.0.1', port, path, servername: RELAY_ID, ca: certificate.cert, headers, agent: false },
            (response) => {
                let body = '';
                response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
                response.on('end', () => {
                    const image = response.headers['ptbk-relay-image'];
                    resolve({
                        status: response.statusCode ?? 0,
                        body,
                        image: typeof image === 'string' ? image : undefined,
                    });
                });
            },
        );
        outgoing.on('error', reject);
        outgoing.end();
    });
}

describe('createOwnTlsServer', () => {
    let server: OwnTlsServer;
    let port: number;

    beforeAll(async () => {
        const { clock, logger, registry, dns } = createTestDeps();
        const endpoint = createTunnelEndpoint({
            relayId: RELAY_ID,
            engineDomain: ENGINE_DOMAIN,
            offer: { versions: [1], features: [] },
            registry: uncached(registry),
            dns,
            random: createFakeRandom(),
            clock,
            logger,
            limits: {
                handshakeTimeoutMs: 10_000,
                maxPending: 100,
                maxPendingPerIp: 100,
                maxTunnelsPerIp: 10,
                handshakesPerIpPerMin: 1000,
                registryMissesPerS: 20,
                session: TEST_SESSION_LIMITS,
            },
            table: createSessionTable<TunnelSession>({ logger }),
            terminations: { count: () => undefined },
            metrics: createMemoryMetrics(),
        });
        server = createOwnTlsServer({
            ...certificate,
            endpoint,
            tunnel: testWsTunnelOptions(systemClock),
            clock: systemClock,
            logger,
            maxConnections: 100,
            metrics: createMetricsEndpoint({ token: { reveal: () => METRICS_TOKEN }, render: () => METRICS_BODY }),
            imageDigest: IMAGE_DIGEST,
        });
        port = await server.listen(0, '127.0.0.1');
    });
    afterAll(async () => {
        await server.close();
    });

    function handshake(options: ConnectionOptions): Promise<Handshake> {
        return new Promise((resolve) => {
            const socket = connect({ host: '127.0.0.1', port, servername: RELAY_ID, ca: certificate.cert, ...options });
            socket.once('secureConnect', () => {
                resolve({ ok: true, protocol: socket.getProtocol(), cipher: socket.getCipher().standardName });
                socket.destroy();
            });
            socket.once('error', () => {
                resolve({ ok: false });
            });
        });
    }

    function get(
        path: string,
        headers: Record<string, string> = {},
        method = 'GET',
    ): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
        return new Promise((resolve, reject) => {
            const outgoing = request(
                {
                    host: '127.0.0.1',
                    port,
                    path,
                    method,
                    servername: RELAY_ID,
                    ca: certificate.cert,
                    headers,
                    agent: false,
                },
                (response) => {
                    let body = '';
                    response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
                    response.on('end', () => {
                        resolve({ status: response.statusCode ?? 0, body, headers: response.headers });
                    });
                },
            );
            outgoing.on('error', reject);
            outgoing.end();
        });
    }

    it.each(['TLSv1.2', 'TLSv1.3'] as const)('resumes no %s session: tickets are off', async (version) => {
        const first = await new Promise<{ session: Buffer | null }>((resolve) => {
            let session: Buffer | null = null;
            const socket = connect({
                host: '127.0.0.1',
                port,
                servername: RELAY_ID,
                ca: certificate.cert,
                minVersion: version,
                maxVersion: version,
            });
            socket.on('session', (ticket: Buffer) => {
                session = ticket;
            });
            socket.once('secureConnect', () => {
                // TLS 1.3 sends its session messages after the handshake; a GET makes the server write.
                socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
            });
            socket.on('data', () => undefined);
            socket.once('close', () => {
                resolve({ session });
            });
        });
        const resumed = await new Promise<boolean>((resolve) => {
            const socket = connect({
                host: '127.0.0.1',
                port,
                servername: RELAY_ID,
                ca: certificate.cert,
                minVersion: version,
                maxVersion: version,
                ...(first.session === null ? {} : { session: first.session }),
            });
            socket.once('secureConnect', () => {
                resolve(socket.isSessionReused());
                socket.destroy();
            });
        });
        expect(resumed).toBe(false);
    });

    it('accepts TLS 1.3', async () => {
        await expect(handshake({ minVersion: 'TLSv1.3' })).resolves.toMatchObject({ ok: true, protocol: 'TLSv1.3' });
    });

    it.each(['ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-RSA-CHACHA20-POLY1305'])(
        'accepts TLS 1.2 with %s',
        async (cipher) => {
            await expect(handshake({ maxVersion: 'TLSv1.2', ciphers: cipher })).resolves.toMatchObject({
                ok: true,
                protocol: 'TLSv1.2',
            });
        },
    );

    it('refuses TLS 1.1', async () => {
        await expect(
            handshake({ minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' }),
        ).resolves.toEqual({ ok: false });
    });

    it.each([
        ['CBC with ECDHE', 'ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:ECDHE-RSA-AES128-SHA'],
        ['static RSA key exchange with AES-GCM', 'AES128-GCM-SHA256:AES256-GCM-SHA384'],
        ['finite-field DHE with AES-GCM', 'DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384'],
    ])('refuses a TLS 1.2 client offering only %s', async (_, ciphers) => {
        await expect(handshake({ maxVersion: 'TLSv1.2', ciphers })).resolves.toEqual({ ok: false });
    });

    it('lists only AEAD suites, and ECDHE ones for TLS 1.2', () => {
        for (const suite of RELAY_TLS_CIPHERS.split(':')) {
            expect(suite).toMatch(
                /^(TLS_(AES_\d+_GCM|CHACHA20_POLY1305)_SHA\d+|ECDHE-(ECDSA|RSA)-(AES\d+-GCM-SHA\d+|CHACHA20-POLY1305))$/,
            );
        }
    });

    it('answers GET /healthz with ok and the image digest, and everything else with 404', async () => {
        await expect(get('/healthz')).resolves.toMatchObject({
            status: 200,
            body: 'ok',
            headers: { 'ptbk-relay-image': IMAGE_DIGEST },
        });
        await expect(get('/')).resolves.toMatchObject({ status: 404 });
        await expect(get('/healthz?x=1')).resolves.toMatchObject({ status: 404 });
        await expect(get(TUNNEL_PATH)).resolves.toMatchObject({ status: 404 });
    });

    it('answers GET /metrics only with the metrics token', async () => {
        const unauthorized = {
            status: 401,
            body: '',
            headers: expect.objectContaining({ 'www-authenticate': 'Bearer' }) as unknown,
        };
        await expect(get('/metrics')).resolves.toMatchObject(unauthorized);
        await expect(get('/metrics', { Authorization: `Bearer ${METRICS_TOKEN}x` })).resolves.toMatchObject(
            unauthorized,
        );
        await expect(get('/metrics', { Authorization: `Basic ${METRICS_TOKEN}` })).resolves.toMatchObject(unauthorized);
        await expect(get('/metrics', { Authorization: `Bearer ptbk_rt_${'k'.repeat(43)}` })).resolves.toMatchObject(
            unauthorized,
        );
        await expect(get('/metrics', { Authorization: `bearer ${METRICS_TOKEN}` })).resolves.toMatchObject({
            status: 200,
            body: METRICS_BODY,
            headers: expect.objectContaining({
                'content-type': 'text/plain; version=0.0.4; charset=utf-8',
                'cache-control': 'no-store',
            }) as unknown,
        });
        await expect(get('/metrics', { Authorization: `Bearer ${METRICS_TOKEN}` }, 'POST')).resolves.toMatchObject({
            status: 404,
            body: '',
        });
        await expect(get('/metrics?x=1', { Authorization: `Bearer ${METRICS_TOKEN}` })).resolves.toMatchObject({
            status: 404,
        });
    });

    const upgrade = {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    };

    it('refuses an upgrade on another path with 404', async () => {
        await expect(get('/v2/tunnel', { ...upgrade, 'Sec-WebSocket-Protocol': 'ptbk-tunnel' })).resolves.toMatchObject(
            { status: 404 },
        );
    });

    it('refuses an upgrade without the ptbk-tunnel subprotocol with 400', async () => {
        await expect(get(TUNNEL_PATH, upgrade)).resolves.toMatchObject({ status: 400 });
        await expect(get(TUNNEL_PATH, { ...upgrade, 'Sec-WebSocket-Protocol': 'chat, other' })).resolves.toMatchObject({
            status: 400,
        });
    });
});

describe('createOwnTlsServer limits and shutdown', () => {
    const start = async (limits: { maxPending: number; maxPendingPerIp: number }) => {
        const { clock, logger, registry, dns } = createTestDeps();
        const graceClock = createFakeClock();
        const endpoint = createTunnelEndpoint({
            relayId: RELAY_ID,
            engineDomain: ENGINE_DOMAIN,
            offer: { versions: [1], features: [] },
            registry: uncached(registry),
            dns,
            random: createFakeRandom(),
            clock,
            logger,
            limits: {
                handshakeTimeoutMs: 10_000,
                maxTunnelsPerIp: 10,
                handshakesPerIpPerMin: 1000,
                registryMissesPerS: 20,
                session: TEST_SESSION_LIMITS,
                ...limits,
            },
            table: createSessionTable<TunnelSession>({ logger }),
            terminations: { count: () => undefined },
            metrics: createMemoryMetrics(),
        });
        const server = createOwnTlsServer({
            ...certificate,
            endpoint,
            tunnel: testWsTunnelOptions(systemClock),
            clock: graceClock,
            logger,
            maxConnections: 100,
            metrics: null,
        });
        const port = await server.listen(0, '127.0.0.1');
        return { server, port, clock, graceClock, logger };
    };
    const closedSocket = (socket: Socket): Promise<unknown> => new Promise((resolve) => socket.once('close', resolve));

    it('sends no image digest when the host set none', async () => {
        const { server, port } = await start({ maxPending: 10, maxPendingPerIp: 10 });
        await expect(getFrom(port, '/healthz')).resolves.toEqual({ status: 200, body: 'ok', image: undefined });
        await server.close();
    });

    it('drops a socket at once when even the rate-limited pool is full', async () => {
        const { server, port, clock } = await start({ maxPending: 1, maxPendingPerIp: 1 });
        const held: Socket[] = [];
        for (let index = 0; index < 2; index++) {
            const timers = clock.pendingTimers();
            const socket = connectTcp(port, '127.0.0.1');
            held.push(socket);
            await vi.waitFor(() => {
                expect(clock.pendingTimers()).toBe(timers + 1);
            });
        }
        const dropped = connectTcp(port, '127.0.0.1');
        dropped.on('error', () => undefined);
        await closedSocket(dropped);
        expect(held.every((socket) => !socket.destroyed)).toBe(true);
        for (const socket of held) socket.destroy();
        await server.close();
    });

    it('destroys a socket whose peer is already gone', async () => {
        const { server } = await start({ maxPending: 10, maxPendingPerIp: 10 });
        const gone = new Socket();
        server.acceptSocket(gone);
        expect(gone.destroyed).toBe(true);
        await server.close();
    });

    it('destroys tunnels that ignore SHUTTING_DOWN after the grace period', async () => {
        const { server, port, graceClock } = await start({ maxPending: 10, maxPendingPerIp: 10 });
        // A WebSocket client that never answers the close handshake.
        const socket = connect({ host: '127.0.0.1', port, servername: RELAY_ID, ca: certificate.cert });
        socket.on('error', () => undefined);
        let response = '';
        socket.setEncoding('utf8').on('data', (chunk: string) => (response += chunk));
        socket.write(
            `GET ${TUNNEL_PATH} HTTP/1.1\r\nHost: ${RELAY_ID}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
                'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
                'Sec-WebSocket-Protocol: ptbk-tunnel\r\n\r\n',
        );
        await vi.waitFor(() => {
            expect(response).toContain('101 Switching Protocols');
        });
        const closing = server.close();
        const gone = closedSocket(socket);
        graceClock.advance(CLOSE_GRACE_MS);
        await gone;
        await closing;
    });

    it('closes without a listener', async () => {
        const { server } = await start({ maxPending: 10, maxPendingPerIp: 10 });
        await server.close();
        const unlistened = createOwnTlsServer({
            ...certificate,
            endpoint: { accept: () => null, shutdown: () => undefined },
            tunnel: testWsTunnelOptions(systemClock),
            clock: systemClock,
            logger: createMemoryLogger(),
            maxConnections: 100,
            metrics: null,
        });
        await expect(unlistened.close()).resolves.toBeUndefined();
    });
});

describe('clientIp', () => {
    it('folds IPv4-mapped IPv6 addresses into IPv4 and keeps everything else', () => {
        expect(clientIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
        expect(clientIp('::ffff:abcd')).toBe('::ffff:abcd');
        expect(clientIp('2001:db8::1')).toBe('2001:db8::1');
        expect(clientIp('192.0.2.1')).toBe('192.0.2.1');
        expect(clientIp(undefined)).toBeUndefined();
    });
});

describe('createOwnTlsServer certificate and listener', () => {
    it('serves a new certificate to new connections after setCertificate, and refuses one Node cannot load', async () => {
        const { clock, logger } = createTestDeps();
        const server = createOwnTlsServer({
            ...certificate,
            endpoint: createTunnelEndpoint({
                relayId: RELAY_ID,
                engineDomain: ENGINE_DOMAIN,
                offer: { versions: [1], features: [] },
                registry: uncached(createTestDeps().registry),
                dns: createTestDeps().dns,
                random: createFakeRandom(),
                clock,
                logger,
                limits: {
                    handshakeTimeoutMs: 10_000,
                    maxPending: 10,
                    maxPendingPerIp: 10,
                    maxTunnelsPerIp: 10,
                    handshakesPerIpPerMin: 1000,
                    registryMissesPerS: 20,
                    session: TEST_SESSION_LIMITS,
                },
                table: createSessionTable<TunnelSession>({ logger }),
                terminations: { count: () => undefined },
                metrics: createMemoryMetrics(),
            }),
            tunnel: testWsTunnelOptions(systemClock),
            clock: systemClock,
            logger,
            maxConnections: 10,
            metrics: null,
        });
        const port = await server.listen(0, '127.0.0.1');
        const fingerprint = (): Promise<string | undefined> =>
            new Promise((resolve) => {
                const socket = connect({ host: '127.0.0.1', port, servername: RELAY_ID, rejectUnauthorized: false });
                socket.once('secureConnect', () => {
                    resolve(socket.getPeerX509Certificate()?.fingerprint256);
                    socket.destroy();
                });
            });
        const next = createTestCertificate([RELAY_ID]);
        expect(await fingerprint()).toBe(new X509Certificate(certificate.cert).fingerprint256);
        server.setCertificate(next.cert, next.key);
        expect(await fingerprint()).toBe(new X509Certificate(next.cert).fingerprint256);
        expect(() => {
            server.setCertificate(next.cert, createTestCertificate([RELAY_ID]).key);
        }).toThrow();
        expect(await fingerprint()).toBe(new X509Certificate(next.cert).fingerprint256);
        await server.close();
    });

    it('caps its connections and survives accept errors, logging only their name', async () => {
        const listen = vi.spyOn(Server.prototype, 'listen');
        const logger = createMemoryLogger();
        const server = createOwnTlsServer({
            ...certificate,
            endpoint: { accept: () => null, shutdown: () => undefined },
            tunnel: testWsTunnelOptions(systemClock),
            clock: systemClock,
            logger,
            maxConnections: 7,
            metrics: null,
        });
        await server.listen(0, '127.0.0.1');
        const listening = listen.mock.contexts[0] as Server;
        listen.mockRestore();
        expect(listening.maxConnections).toBe(7);
        listening.emit('error', Object.assign(new Error('accept failed: too many open files'), { code: 'EMFILE' }));
        expect(logger.entries).toEqual([
            { level: 'error', event: 'relay.accept-failed', fields: { problem: 'Error' } },
        ]);
        await server.close();
    });
});
