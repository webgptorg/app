import type { AddressInfo, Server } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { createServer } from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestCa } from '../pki/test-ca';
import { createNodeStagingPorts, createTlsProbe, lookupAddresses } from './node-ports';

const HOST = 'engine.test';
const ca = createTestCa('Staging probe test CA');
const servers: Server[] = [];
let tlsPort = 0;
let silentPort = 0;

function listen(server: Server): Promise<number> {
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as AddressInfo).port);
        });
    });
}

beforeAll(async () => {
    const leaf = ca.issue([HOST]);
    tlsPort = await listen(createServer({ cert: leaf.certPem, key: leaf.keyPem }, (socket) => socket.end()));
    // Accepts TCP and never answers the ClientHello, like a relay holding a dead tunnel.
    silentPort = await listen(createTcpServer(() => undefined));
});

afterAll(() => {
    for (const server of servers) server.close();
});

const signal = (): AbortSignal => AbortSignal.timeout(5000);

describe('createTlsProbe', () => {
    it('reports a chain the given roots trust, with its issuer and expiry', async () => {
        const probe = await createTlsProbe({ ca: [ca.certPem], port: tlsPort, connectTo: '127.0.0.1' })(HOST, signal());
        expect(probe).toMatchObject({
            kind: 'handshake',
            authorized: true,
            authorizationError: null,
            hostnameMatches: true,
            issuer: { organization: null, commonName: 'Staging probe test CA' },
        });
        expect(probe.kind === 'handshake' && probe.validToMs > Date.now()).toBe(true);
    });

    it('trusts only the public roots by default, so a private CA reports why', async () => {
        const probe = await createTlsProbe({ port: tlsPort, connectTo: '127.0.0.1' })(HOST, signal());
        expect(probe).toMatchObject({ kind: 'handshake', authorized: false });
        expect(probe.kind === 'handshake' ? probe.authorizationError : null).toMatch(/^[A-Z_]+$/);
    });

    it('notices a certificate for another name', async () => {
        const probe = await createTlsProbe({ ca: [ca.certPem], port: tlsPort, connectTo: '127.0.0.1' })(
            'other.test',
            signal(),
        );
        expect(probe).toMatchObject({ kind: 'handshake', hostnameMatches: false });
    });

    it('reports a refused connection by its code', async () => {
        const closed = createTcpServer();
        const port = await listen(closed);
        await new Promise((resolve) => closed.close(resolve));
        expect(await createTlsProbe({ port, connectTo: '127.0.0.1' })(HOST, signal())).toEqual({
            kind: 'failed',
            code: 'ECONNREFUSED',
        });
    });

    it('gives up when the handshake does not finish in time', async () => {
        const probe = createTlsProbe({ port: silentPort, connectTo: '127.0.0.1' });
        expect(await probe(HOST, AbortSignal.timeout(100))).toEqual({ kind: 'failed', code: 'TIMEOUT' });
        expect(await probe(HOST, AbortSignal.abort())).toEqual({ kind: 'failed', code: 'TIMEOUT' });
    });
});

describe('lookupAddresses', () => {
    it('resolves through the system resolver', async () => {
        const answer = await lookupAddresses('localhost', signal());
        expect(answer.kind).toBe('resolved');
        expect(answer.kind === 'resolved' && answer.addresses.some((a) => a === '127.0.0.1' || a === '::1')).toBe(true);
    });

    it('reports a timeout as a failed lookup', async () => {
        expect(await lookupAddresses('localhost', AbortSignal.abort())).toEqual({ kind: 'failed', code: 'TIMEOUT' });
    });
});

it('builds the production ports around the given fetch', () => {
    const ports = createNodeStagingPorts(globalThis.fetch);
    expect(ports.fetch).toBe(globalThis.fetch);
    expect(Math.abs(ports.nowMs() - Date.now())).toBeLessThan(1000);
});
