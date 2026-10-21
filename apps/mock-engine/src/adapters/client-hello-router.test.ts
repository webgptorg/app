import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { duplexPair } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { connect } from 'node:tls';

import { crypto as acmeCrypto } from 'acme-client';
import type { Authorization } from 'acme-client';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../domain/clock';
import { secret } from '../domain/secret';
import { createAcmeChallenges } from '../domain/tls/acme-challenges';
import { captureClientHello } from '../testing/client-hello';
import { createFakeClock } from '../testing/fake-clock';
import { HARNESS_DOMAIN, HARNESS_HOSTNAME } from '../testing/engine-harness';
import { createMemoryLogger } from '../testing/memory-logger';
import type { PeekOutcome } from './client-hello-router';
import { createClientHelloRouter, peekClientHello } from './client-hello-router';
import { createDevCa, createDevCaCertificateSource } from './dev-ca';
import { createTlsAlpnResponder } from './tls-alpn-responder';
import { HANDSHAKE_TIMEOUT_MS, createTlsStreamServer } from './tls-stream-server';

const REMOTE = { family: 'IPv4', address: '192.0.2.7', port: 40_000 } as const;

const realClock: Clock = {
    nowMs: () => Date.now(),
    setTimeout(fn, ms) {
        const timer = setTimeout(fn, ms);
        return () => {
            clearTimeout(timer);
        };
    },
};

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function peek(stream: Duplex, clock: Clock = realClock): Promise<PeekOutcome> {
    return new Promise((resolve) => {
        peekClientHello(stream, { clock, timeoutMs: HANDSHAKE_TIMEOUT_MS }, resolve);
    });
}

async function drain(stream: Duplex, bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < bytes) {
        const chunk = stream.read() as Buffer | null;
        if (chunk === null) await once(stream, 'readable');
        else {
            chunks.push(chunk);
            length += chunk.length;
        }
    }
    return Buffer.concat(chunks);
}

describe('peekClientHello', () => {
    it('waits for a hello split across chunks, then puts every byte back', async () => {
        const hello = await captureClientHello({ servername: HARNESS_HOSTNAME, ALPNProtocols: ['http/1.1'] });
        const [writer, stream] = duplexPair();
        const outcome = peek(stream);
        writer.write(hello.subarray(0, 5));
        await new Promise((resolve) => setImmediate(resolve));
        writer.write(hello.subarray(5, 100));
        await new Promise((resolve) => setImmediate(resolve));
        writer.write(Buffer.concat([hello.subarray(100), Buffer.from('after')]));
        expect(await outcome).toEqual({ kind: 'sni', hostname: HARNESS_HOSTNAME, alpn: ['http/1.1'] });
        expect((await drain(stream, hello.length + 5)).equals(Buffer.concat([hello, Buffer.from('after')]))).toBe(true);
    });

    it('gives up when no complete hello arrives in time', async () => {
        const clock = createFakeClock();
        const [writer, stream] = duplexPair();
        const outcome = peek(stream, clock);
        writer.write(Buffer.of(0x16, 0x03, 0x01));
        await new Promise((resolve) => setImmediate(resolve));
        clock.advance(HANDSHAKE_TIMEOUT_MS);
        expect(await outcome).toEqual({ kind: 'timeout' });
        expect(clock.pendingTimers()).toBe(0);
    });

    it('reports a stream that ends before its hello', async () => {
        const [writer, stream] = duplexPair();
        const outcome = peek(stream);
        writer.end(Buffer.of(0x16, 0x03, 0x01));
        stream.resume();
        expect(await outcome).toEqual({ kind: 'ended' });
    });
});

describe('ClientHello router', () => {
    function setup(clock: Clock = realClock) {
        const logger = createMemoryLogger();
        const challenges = createAcmeChallenges();
        const ca = createDevCa([HARNESS_DOMAIN], clock);
        const certificates = createDevCaCertificateSource({ ca, clock, logger });
        certificates.addHostnames([HARNESS_HOSTNAME]);
        const tls = createTlsStreamServer({
            certificates,
            logger,
            onSecureConnection: (socket) => {
                socket.end();
            },
        });
        const responder = createTlsAlpnResponder({ challenges, logger });
        const router = createClientHelloRouter({
            challenges,
            responder,
            normal: (stream, remote) => {
                tls.handle(stream, remote);
            },
            clock,
            logger,
        });
        cleanups.push(() => {
            router.close();
            responder.close();
            tls.close();
            certificates.close();
        });
        function open(ALPNProtocols: string[]): { client: TLSSocket; stream: Duplex; received: () => number } {
            const [clientEnd, stream] = duplexPair();
            let received = 0;
            clientEnd.on('data', (chunk: Buffer) => {
                received += chunk.length;
            });
            clientEnd.once('close', () => stream.destroy());
            stream.once('close', () => clientEnd.destroy());
            router.handle(stream, REMOTE);
            const client = connect({
                socket: clientEnd,
                servername: HARNESS_HOSTNAME,
                ALPNProtocols,
                ca: ca.certificatePem,
                rejectUnauthorized: !ALPNProtocols.includes('acme-tls/1'),
            });
            client.on('error', () => undefined);
            return { client, stream, received: () => received };
        }
        return { logger, challenges, router, open };
    }

    it('hands a browser hello, untouched, to the TLS server', async () => {
        const { open } = setup();
        const { client } = open(['http/1.1']);
        await once(client, 'secureConnect');
        expect(client.alpnProtocol).toBe('http/1.1');
        expect(client.getPeerX509Certificate()?.checkHost(HARNESS_HOSTNAME)).toBe(HARNESS_HOSTNAME);
        client.destroy();
    });

    it('hands an acme-tls/1 hello with a pending challenge to the responder', async () => {
        const { challenges, open } = setup();
        const key = generateKeyPairSync('ec', { namedCurve: 'P-256' })
            .privateKey.export({ type: 'pkcs8', format: 'pem' })
            .toString();
        const authz = { identifier: { type: 'dns', value: HARNESS_HOSTNAME } } as unknown as Authorization;
        const [, certificate] = await acmeCrypto.createAlpnCertificate(authz, 'key.authorization', key);
        challenges.register(HARNESS_HOSTNAME, {
            certificateChainPem: certificate.toString(),
            privateKeyPem: secret(key),
        });
        const { client } = open(['acme-tls/1']);
        await once(client, 'secureConnect');
        expect(client.alpnProtocol).toBe('acme-tls/1');
        expect(
            acmeCrypto.isAlpnCertificateAuthorizationValid(
                client.getPeerX509Certificate()?.toString() ?? '',
                'key.authorization',
            ),
        ).toBe(true);
        client.destroy();
    });

    it('closes an acme-tls/1 connection without a pending challenge before writing a byte', async () => {
        const { logger, open } = setup();
        const { client, stream, received } = open(['acme-tls/1']);
        await once(client, 'close');
        expect(stream.destroyed).toBe(true);
        expect(received()).toBe(0);
        expect(logger.entries).toContainEqual(
            expect.objectContaining({ event: 'tls.hello-rejected', fields: { reason: 'no-pending-challenge' } }),
        );
    });

    it('closes a stream that is not TLS', async () => {
        const { logger, router } = setup();
        const [writer, stream] = duplexPair();
        router.handle(stream, REMOTE);
        writer.write('GET / HTTP/1.1\r\n\r\n');
        await once(stream, 'close');
        expect(logger.entries).toContainEqual(
            expect.objectContaining({ event: 'tls.hello-rejected', fields: { reason: 'malformed' } }),
        );
    });

    it('closes a stream whose hello never completes', async () => {
        const clock = createFakeClock(Date.now());
        const { logger, router } = setup(clock);
        const [, stream] = duplexPair();
        router.handle(stream, REMOTE);
        clock.advance(HANDSHAKE_TIMEOUT_MS);
        await once(stream, 'close');
        expect(logger.entries).toContainEqual(
            expect.objectContaining({ event: 'tls.hello-incomplete', fields: { outcome: 'timeout' } }),
        );
    });

    it('destroys streams still being peeked at on close, and streams that arrive afterwards', () => {
        const { router } = setup();
        const [, waiting] = duplexPair();
        router.handle(waiting, REMOTE);
        router.close();
        expect(waiting.destroyed).toBe(true);
        const [, late] = duplexPair();
        router.handle(late, REMOTE);
        expect(late.destroyed).toBe(true);
    });
});
