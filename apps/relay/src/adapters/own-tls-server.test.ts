import { request } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import { connect } from 'node:tls';

import { TUNNEL_PATH } from '@ptbk/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSessionTable } from '../domain/tunnel/session-table';
import { createTunnelEndpoint } from '../domain/tunnel/tunnel-endpoint';
import type { TunnelSession } from '../domain/tunnel/tunnel-session';
import { ENGINE_DOMAIN } from '../testing/engines';
import { createFakeRandom } from '../testing/fake-random';
import { RELAY_ID } from '../testing/relay-harness';
import { createTestCertificate } from '../testing/test-pki';
import { createTestDeps } from '../testing/test-deps';
import type { OwnTlsServer } from './own-tls-server';
import { RELAY_TLS_CIPHERS, clientIp, createOwnTlsServer } from './own-tls-server';
import { systemClock } from './system-clock';

type Handshake =
    { readonly ok: true; readonly protocol: string | null; readonly cipher: string } | { readonly ok: false };

// An RSA certificate, so a client can offer static-RSA and DHE-RSA suites that the relay must refuse by policy.
const certificate = createTestCertificate([RELAY_ID], 'rsa');

describe('createOwnTlsServer', () => {
    let server: OwnTlsServer;
    let port: number;

    beforeAll(async () => {
        const { clock, logger, registry, dns } = createTestDeps();
        const endpoint = createTunnelEndpoint({
            relayId: RELAY_ID,
            engineDomain: ENGINE_DOMAIN,
            offer: { versions: [1], features: [] },
            registry,
            dns,
            random: createFakeRandom(),
            clock,
            logger,
            limits: { handshakeTimeoutMs: 10_000, maxPending: 100, maxPendingPerIp: 100, maxTunnelsPerIp: 10 },
            table: createSessionTable<TunnelSession>({ logger }),
        });
        server = createOwnTlsServer({
            ...certificate,
            endpoint,
            liveness: { clock: systemClock },
            clock: systemClock,
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

    function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
        return new Promise((resolve, reject) => {
            const outgoing = request(
                { host: '127.0.0.1', port, path, servername: RELAY_ID, ca: certificate.cert, headers, agent: false },
                (response) => {
                    let body = '';
                    response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
                    response.on('end', () => {
                        resolve({ status: response.statusCode ?? 0, body });
                    });
                },
            );
            outgoing.on('error', reject);
            outgoing.end();
        });
    }

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

    it('answers GET /healthz with ok and everything else with 404', async () => {
        await expect(get('/healthz')).resolves.toEqual({ status: 200, body: 'ok' });
        await expect(get('/')).resolves.toMatchObject({ status: 404 });
        await expect(get('/healthz?x=1')).resolves.toMatchObject({ status: 404 });
        await expect(get(TUNNEL_PATH)).resolves.toMatchObject({ status: 404 });
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

describe('clientIp', () => {
    it('folds IPv4-mapped IPv6 addresses into IPv4 and keeps everything else', () => {
        expect(clientIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
        expect(clientIp('::ffff:abcd')).toBe('::ffff:abcd');
        expect(clientIp('2001:db8::1')).toBe('2001:db8::1');
        expect(clientIp('192.0.2.1')).toBe('192.0.2.1');
        expect(clientIp(undefined)).toBeUndefined();
    });
});
