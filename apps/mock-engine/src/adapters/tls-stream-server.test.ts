import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { duplexPair } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { connect } from 'node:tls';

import { Hostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeClock } from '../testing/fake-clock';
import type { EngineHarness } from '../testing/engine-harness';
import { HARNESS_CLIENT_IP, HARNESS_ENGINE_ID, HARNESS_HOSTNAME, createEngineHarness } from '../testing/engine-harness';
import { createMemoryLogger } from '../testing/memory-logger';
import { LEAF_RENEW_AFTER_MS, createDevCa, createDevCaCertificateSource } from './dev-ca';
import type { SecureConnection } from './tls-stream-server';
import { createTlsStreamServer } from './tls-stream-server';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function harness(options: Parameters<typeof createEngineHarness>[0] = {}): EngineHarness {
    const created = createEngineHarness(options);
    cleanups.push(() => {
        created.close();
    });
    return created;
}

function handshakeError(socketPromise: Promise<TLSSocket>): Promise<NodeJS.ErrnoException> {
    return socketPromise.then(
        () => {
            throw new Error('the handshake succeeded');
        },
        (error: unknown) => error as NodeJS.ErrnoException,
    );
}

async function closed(stream: Duplex): Promise<void> {
    if (stream.closed) return;
    await once(stream, 'close');
}

describe('TLS stream server (no relay: linked duplexes stand in for a tunnel stream)', () => {
    it('serves whoami with the client IP from the OPEN frame, over TLS 1.3 and http/1.1', async () => {
        const engine = harness();
        const response = await engine.get('/__spike/whoami', { clientIp: '203.0.113.99' });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.toString('utf8'))).toEqual({
            engineId: HARNESS_ENGINE_ID,
            hostname: HARNESS_HOSTNAME,
            clientIp: '203.0.113.99',
            alpn: 'http/1.1',
            tlsVersion: 'TLSv1.3',
        });
    });

    it('presents the dev CA leaf for the engine hostname', async () => {
        const engine = harness();
        const socket = await engine.connect();
        const peer = socket.getPeerX509Certificate();
        expect(socket.authorized).toBe(true);
        expect(peer?.subjectAltName).toBe(`DNS:${HARNESS_HOSTNAME}`);
        expect(peer?.checkIssued(engine.ca.certificate)).toBe(true);
        socket.destroy();
    });

    it('fails the handshake for a wrong SNI, without SNI, and below TLS 1.3', async () => {
        const engine = harness();
        const wrong = await handshakeError(engine.connect({ servername: 'other.engine.test' }));
        // Node aborts an SNI callback error without an alert, so the client sees the stream go away mid-handshake.
        expect(wrong.code).toBe('ECONNRESET');
        const missing = await handshakeError(engine.connect({ servername: null }));
        expect(missing.code).toMatch(/^ERR_SSL_/);

        const [client, server] = duplexPair();
        engine.tls.handle(server, { family: 'IPv4', address: HARNESS_CLIENT_IP, port: 1 });
        const legacy = connect({
            socket: client,
            servername: HARNESS_HOSTNAME,
            ca: engine.ca.certificatePem,
            maxVersion: 'TLSv1.2',
        });
        const [error] = (await once(legacy, 'error')) as [NodeJS.ErrnoException];
        expect(error.code).toMatch(/^ERR_SSL_/);

        expect(engine.logger.entries.filter((entry) => entry.event === 'tls.handshake-failed').length).toBe(3);
        await closed(server);
        expect(engine.tls.connections()).toBe(0);
    });

    it('fails the handshake when the source holds no certificate for a valid hostname of another engine', async () => {
        const engine = harness();
        const error = await handshakeError(
            engine.connect({ servername: Hostname.parse('bbbbbbbbbbbbbbbbbbbbbbbbbb.engine.test') }),
        );
        expect(error.code).toBe('ECONNRESET');
    });

    it('applies a renewed certificate to new connections without a restart', async () => {
        // Starts in the past so the renewed leaf is valid by the real clock the TLS client checks against.
        const clock = createFakeClock(Date.now() - LEAF_RENEW_AFTER_MS);
        const engine = harness({ clock });
        const before = await engine.connect();
        const first = before.getPeerX509Certificate()?.fingerprint256;

        clock.advance(LEAF_RENEW_AFTER_MS);
        const after = await engine.connect();
        const second = after.getPeerX509Certificate()?.fingerprint256;
        expect(second).toBeDefined();
        expect(second).not.toBe(first);
        // The connection made before the renewal keeps its session.
        expect(before.destroyed).toBe(false);
        before.destroy();
        after.destroy();
    });
});

describe('TLS stream server lifecycle', () => {
    function setup() {
        const clock = createFakeClock(Date.now());
        const logger = createMemoryLogger();
        const ca = createDevCa([Hostname.parse('engine.test')], clock);
        const certificates = createDevCaCertificateSource({ ca, clock, logger });
        certificates.addHostnames([HARNESS_HOSTNAME]);
        const secured: { socket: TLSSocket; connection: SecureConnection }[] = [];
        const server = createTlsStreamServer({
            certificates,
            logger,
            onSecureConnection: (socket, connection) => {
                secured.push({ socket, connection });
            },
        });
        cleanups.push(() => {
            server.close();
            certificates.close();
        });
        async function open(): Promise<{ client: TLSSocket; stream: Duplex; socket: TLSSocket }> {
            const [clientEnd, stream] = duplexPair();
            server.handle(stream, { family: 'IPv6', address: '2001:db8::7', port: 443 });
            const client = connect({ socket: clientEnd, servername: HARNESS_HOSTNAME, ca: ca.certificatePem });
            await once(client, 'secureConnect');
            while (secured.length === 0) await new Promise((resolve) => setImmediate(resolve));
            const entry = secured.shift();
            if (entry === undefined) throw new Error('no secure connection');
            expect(entry.connection.clientIp).toBe('2001:db8::7');
            return { client, stream, socket: entry.socket };
        }
        return { server, open };
    }

    it('destroys the TLS socket when the tunnel stream closes', async () => {
        const { server, open } = setup();
        const { client, stream, socket } = await open();
        expect(server.connections()).toBe(1);
        stream.destroy();
        await closed(socket);
        expect(server.connections()).toBe(0);
        client.destroy();
    });

    it('destroys the tunnel stream when the TLS socket closes', async () => {
        const { server, open } = setup();
        const { client, stream, socket } = await open();
        socket.destroy();
        await closed(stream);
        expect(server.connections()).toBe(0);
        client.destroy();
    });

    it('destroys the stream when the handshake times out', async () => {
        const logger = createMemoryLogger();
        const clock = createFakeClock(Date.now());
        const ca = createDevCa([Hostname.parse('engine.test')], clock);
        const certificates = createDevCaCertificateSource({ ca, clock, logger });
        const server = createTlsStreamServer({
            certificates,
            logger,
            handshakeTimeoutMs: 20,
            onSecureConnection: () => undefined,
        });
        cleanups.push(() => {
            server.close();
        });
        const [silent, stream] = duplexPair();
        server.handle(stream, { family: 'IPv4', address: HARNESS_CLIENT_IP, port: 1 });
        await closed(stream);
        expect(logger.entries).toContainEqual(
            expect.objectContaining({ event: 'tls.handshake-failed', fields: { code: 'ERR_TLS_HANDSHAKE_TIMEOUT' } }),
        );
        silent.destroy();
    });

    it('destroys every connection on close, and streams that arrive afterwards', async () => {
        const { server, open } = setup();
        const { client, stream } = await open();
        server.close();
        await closed(stream);
        expect(server.connections()).toBe(0);
        const [late, lateStream] = duplexPair();
        server.handle(lateStream, { family: 'IPv4', address: HARNESS_CLIENT_IP, port: 1 });
        expect(lateStream.destroyed).toBe(true);
        client.destroy();
        late.destroy();
    });
});
