import type { AddressInfo, Socket } from 'node:net';
import { connect as connectTcp, createServer } from 'node:net';
import { connect as connectTls } from 'node:tls';

import { parseClientHello } from '@ptbk/protocol';

/**
 * A real ClientHello as Node's TLS client sends it: with `servername` as SNI, or without SNI when it is omitted (Node
 * sends none for an IP address). Captured from a throwaway local server, so tests can replay it byte for byte.
 */
export async function captureClientHello(servername?: string, alpn?: readonly string[]): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
        return await new Promise<Buffer>((resolve) => {
            server.once('connection', (socket: Socket) => {
                socket.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                    const bytes = Buffer.concat(chunks);
                    if (parseClientHello(bytes, { maxBytes: 16_384 }).kind !== 'need-more') {
                        socket.destroy();
                        resolve(bytes);
                    }
                });
            });
            const client = connectTls({
                host: '127.0.0.1',
                port,
                ...(servername === undefined ? {} : { servername }),
                ...(alpn === undefined ? {} : { ALPNProtocols: [...alpn] }),
            });
            client.on('error', () => undefined);
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

export interface RawClient {
    readonly socket: Socket;
    /** Everything the relay sent so far. */
    received(): Buffer;
    /** Resolves once the relay closed the connection, with everything it sent. */
    readonly closed: Promise<Buffer>;
}

/** A plain TCP client that records every byte it receives, to prove what a refused connection got: nothing. */
export function rawClient(port: number): RawClient {
    const socket = connectTcp(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => undefined);
    const received = (): Buffer => Buffer.concat(chunks);
    const closed = new Promise<Buffer>((resolve) => {
        socket.once('close', () => {
            resolve(received());
        });
    });
    return { socket, received, closed };
}
