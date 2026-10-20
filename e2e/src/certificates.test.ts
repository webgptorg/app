import { createHash } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { commonName, leafFromCdpChain, rawTlsAttempt, sha256Hex } from './certificates.ts';

describe('sha256Hex', () => {
    it('is the lowercase hex digest of the DER bytes', () => {
        const bytes = new Uint8Array([1, 2, 3]);
        expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    });
});

describe('commonName', () => {
    it("reads CN from Node's multi-line distinguished names", () => {
        expect(commonName('O=Example\nCN=Promptbook mock engine dev CA')).toBe('Promptbook mock engine dev CA');
        expect(commonName('O=Example')).toBeUndefined();
    });
});

describe('leafFromCdpChain', () => {
    it('needs at least the leaf', () => {
        expect(() => leafFromCdpChain([])).toThrow('no certificate');
    });
});

/** A TCP server that answers each connection with `reply` (possibly nothing) and hangs up after the first bytes. */
async function withServer(reply: Buffer | null, test: (port: number) => Promise<void>): Promise<void> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('data', () => {
            if (reply === null) socket.destroy();
            else socket.end(reply);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        await test((server.address() as AddressInfo).port);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('rawTlsAttempt', () => {
    it('reports a peer that hangs up after the ClientHello without a byte', async () => {
        await withServer(null, async (port) => {
            expect(await rawTlsAttempt({ address: '127.0.0.1', port, servername: 'unknown.engine.test' })).toEqual({
                kind: 'closed',
                bytesReceived: 0,
            });
        });
    });

    it('counts the bytes of a peer that answers, even with garbage', async () => {
        await withServer(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'), async (port) => {
            const outcome = await rawTlsAttempt({ address: '127.0.0.1', port, servername: 'unknown.engine.test' });
            expect(outcome.kind).toBe('closed');
            expect(outcome.bytesReceived).toBe(28);
        });
    });

    it('times out on a peer that never answers', async () => {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => sockets.add(socket));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const port = (server.address() as AddressInfo).port;
            expect(await rawTlsAttempt({ address: '127.0.0.1', port, servername: 'a.test', timeoutMs: 100 })).toEqual({
                kind: 'timeout',
                bytesReceived: 0,
            });
        } finally {
            for (const socket of sockets) socket.destroy();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
