import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { duplexPair } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { connect } from 'node:tls';

import { Hostname } from '@ptbk/protocol';
import { crypto as acmeCrypto } from 'acme-client';
import type { Authorization } from 'acme-client';
import { afterEach, describe, expect, it } from 'vitest';

import { secret } from '../domain/secret';
import { createAcmeChallenges } from '../domain/tls/acme-challenges';
import { createMemoryLogger } from '../testing/memory-logger';
import { createTlsAlpnResponder } from './tls-alpn-responder';
import { certificateExtensions } from './x509/certificate';

const HOST = Hostname.parse('abcdefghijklmnopqrstuvwxyz.engine.test');
const OTHER = Hostname.parse('other.engine.test');
const KEY_AUTHORIZATION = 'token-from-the-ca.thumbprint-of-the-account';

async function challengeFor(hostname: Hostname, keyAuthorization = KEY_AUTHORIZATION) {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
    const authz = { identifier: { type: 'dns', value: hostname } } as unknown as Authorization;
    const [, certificate] = await acmeCrypto.createAlpnCertificate(authz, keyAuthorization, key);
    return { certificateChainPem: certificate.toString('utf8'), privateKeyPem: secret(key) };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
    const logger = createMemoryLogger();
    const challenges = createAcmeChallenges();
    const responder = createTlsAlpnResponder({ challenges, logger });
    cleanups.push(() => {
        responder.close();
    });
    function open(
        dispatched: Hostname,
        servername: string,
        ALPNProtocols: string[],
    ): { client: TLSSocket; stream: Duplex } {
        const [clientEnd, stream] = duplexPair();
        clientEnd.once('close', () => stream.destroy());
        stream.once('close', () => clientEnd.destroy());
        responder.handle(stream, dispatched);
        const client = connect({ socket: clientEnd, servername, ALPNProtocols, rejectUnauthorized: false });
        client.on('error', () => undefined);
        return { client, stream };
    }
    return { logger, challenges, responder, open };
}

function handshake(client: TLSSocket): Promise<'secure' | NodeJS.ErrnoException> {
    return new Promise((resolve) => {
        client.once('secureConnect', () => {
            resolve('secure');
        });
        client.once('error', (error: NodeJS.ErrnoException) => {
            resolve(error);
        });
    });
}

describe('TLS-ALPN-01 responder', () => {
    it('negotiates acme-tls/1 and presents the challenge certificate with the acmeIdentifier extension', async () => {
        const { logger, challenges, open } = setup();
        challenges.register(HOST, await challengeFor(HOST));
        const { client, stream } = open(HOST, HOST, ['acme-tls/1']);
        expect(await handshake(client)).toBe('secure');
        expect(client.alpnProtocol).toBe('acme-tls/1');
        const certificate = client.getPeerX509Certificate();
        if (certificate === undefined) throw new Error('no certificate');
        expect(certificate.subjectAltName).toBe(`DNS:${HOST}`);
        expect(acmeCrypto.isAlpnCertificateAuthorizationValid(certificate.toString(), KEY_AUTHORIZATION)).toBe(true);
        expect(acmeCrypto.isAlpnCertificateAuthorizationValid(certificate.toString(), 'another.authorization')).toBe(
            false,
        );
        expect(certificateExtensions(certificate.raw).get('1.3.6.1.5.5.7.1.31')?.critical).toBe(true);
        client.end();
        await once(stream, 'close');
        expect(logger.entries).toContainEqual(
            expect.objectContaining({ event: 'acme.challenge-served', fields: { hostname: HOST } }),
        );
    });

    it('offers only acme-tls/1: a client offering anything else fails the handshake', async () => {
        const { logger, challenges, open } = setup();
        challenges.register(HOST, await challengeFor(HOST));
        const { client, stream } = open(HOST, HOST, ['http/1.1']);
        const outcome = await handshake(client);
        expect(outcome).not.toBe('secure');
        expect((outcome as NodeJS.ErrnoException).code).toBe('ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL');
        if (!stream.closed) await once(stream, 'close');
        expect(logger.entries.map((entry) => entry.event)).toContain('acme.challenge-handshake-failed');
    });

    it('fails the handshake when the challenge settled while the hello was in flight', async () => {
        const { logger, open } = setup();
        const { client } = open(HOST, HOST, ['acme-tls/1']);
        expect(await handshake(client)).not.toBe('secure');
        expect(logger.entries).toContainEqual(
            expect.objectContaining({
                event: 'acme.challenge-handshake-failed',
                fields: { hostname: HOST, code: 'ERR_NO_PENDING_CHALLENGE' },
            }),
        );
    });

    it('answers only for the hostname the router dispatched on', async () => {
        const { challenges, open } = setup();
        challenges.register(HOST, await challengeFor(HOST));
        challenges.register(OTHER, await challengeFor(OTHER));
        const { client } = open(HOST, OTHER, ['acme-tls/1']);
        expect(await handshake(client)).not.toBe('secure');
    });

    it('destroys every connection on close, and streams that arrive afterwards', async () => {
        const { responder, challenges, open } = setup();
        challenges.register(HOST, await challengeFor(HOST));
        const [, waiting] = duplexPair();
        responder.handle(waiting, HOST);
        responder.close();
        expect(waiting.destroyed).toBe(true);
        const { stream } = open(HOST, HOST, ['acme-tls/1']);
        expect(stream.destroyed).toBe(true);
    });
});
