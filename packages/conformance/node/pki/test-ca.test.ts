import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect, createServer } from 'node:tls';

import { describe, expect, it } from 'vitest';

import { createTestCa } from './test-ca';

async function handshake(
    ca: string,
    credentials: { certPem: string; keyPem: string },
    servername: string,
): Promise<string | null> {
    const server = createServer({ cert: credentials.certPem, key: credentials.keyPem }, (socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
        return await new Promise((resolve) => {
            const socket = connect({ host: '127.0.0.1', port, servername, ca });
            socket.once('secureConnect', () => {
                socket.end();
                resolve(null);
            });
            // Node reports name-constraint violations (X509_V_ERR 47 and 48) as `UNSPECIFIED`; the message names them.
            socket.once('error', (error: Error & { code?: string }) => {
                resolve(error.code === 'UNSPECIFIED' ? error.message : (error.code ?? error.message));
            });
        });
    } finally {
        server.close();
    }
}

describe('createTestCa', () => {
    it('issues server certificates that verify for their names, name-constrained when asked', async () => {
        const ca = createTestCa('test CA', { permittedDomains: ['localhost'] });
        const root = new X509Certificate(ca.certPem);
        expect(root.ca).toBe(true);
        const leaf = ca.issue(['dashboard.localhost', 'relay.localhost']);
        const parsed = new X509Certificate(leaf.certPem);
        expect(parsed.checkIssued(root)).toBe(true);
        expect(parsed.verify(root.publicKey)).toBe(true);
        expect(parsed.subjectAltName).toBe('DNS:dashboard.localhost, DNS:relay.localhost');
        expect(await handshake(ca.certPem, leaf, 'relay.localhost')).toBeNull();
        expect(await handshake(ca.certPem, leaf, 'other.localhost')).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
        expect(await handshake(ca.certPem, ca.issue(['example.com']), 'example.com')).toMatch(
            /permitted subtree violation/i,
        );
        expect(await handshake(ca.certPem, ca.issue(['127.0.0.1']), '127.0.0.1')).toMatch(
            /excluded subtree violation/i,
        );
    });

    it('issues certificates with the validity asked for, and refuses one without a name', async () => {
        const ca = createTestCa('unconstrained CA');
        const expired = ca.issue(['relay.localhost'], {
            notBefore: new Date('2020-01-01T00:00:00Z'),
            notAfter: new Date('2051-01-01T00:00:00Z'),
        });
        expect(new X509Certificate(expired.certPem).validTo).toContain('2051');
        const past = ca.issue(['relay.localhost'], { notAfter: new Date(Date.now() - 1000) });
        expect(await handshake(ca.certPem, past, 'relay.localhost')).toBe('CERT_HAS_EXPIRED');
        expect(await handshake(ca.certPem, ca.issue(['example.com']), 'example.com')).toBeNull();
        expect(() => ca.issue([])).toThrow(RangeError);
    });
});
