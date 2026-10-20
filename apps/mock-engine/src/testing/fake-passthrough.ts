import { once } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import { createServer, isIPv4 } from 'node:net';

import type { Hostname } from '@ptbk/protocol';
import { createClientHelloBuffer } from '@ptbk/protocol';

import type { FakeRelaySession } from './fake-relay';
import { createRelayStreamPeer } from './relay-stream-peer';

const MAX_CLIENT_HELLO_BYTES = 16 * 1024;

export interface FakePassthrough {
    readonly port: number;
    /** Connections refused for an unknown, missing or malformed SNI. */
    refused(): number;
    close(): Promise<void>;
}

/**
 * The browser side of an in-test relay (R-04 stands in for it once merged): reads the SNI from the ClientHello with
 * `@ptbk/protocol`, opens a tunnel stream to the engine whose `ready` named that hostname, and pipes the still
 * encrypted bytes both ways. It never holds a key, so it cannot decrypt anything it forwards.
 */
export async function startFakePassthrough(session: FakeRelaySession): Promise<FakePassthrough> {
    const peer = createRelayStreamPeer({
        send: (bytes) => {
            session.sendBinary(bytes);
        },
    });
    session.onBinary((bytes) => {
        peer.receive(bytes);
    });
    const routable = new Set<Hostname>(session.ready.hostnames);
    const sockets = new Set<Socket>();
    let refused = 0;

    function pipe(socket: Socket, first: Uint8Array): void {
        const address = socket.remoteAddress ?? '';
        if (!isIPv4(address)) throw new Error('the fake passthrough listens on IPv4 only');
        const stream = peer.open({
            family: 4,
            address: Uint8Array.from(address.split('.').map(Number)),
            port: socket.remotePort ?? 0,
        });
        stream.onData((payload) => socket.write(payload));
        void stream.waitForClose().then(() => socket.end());
        // The engine may close the stream while browser bytes are still on their way; drop the browser then.
        const failed = (): void => {
            socket.destroy();
        };
        let writing = stream.write(first).catch(failed);
        socket.on('data', (chunk: Buffer) => {
            socket.pause();
            writing = writing
                .then(() => stream.write(chunk))
                .catch(failed)
                .finally(() => socket.resume());
        });
        socket.once('close', () => {
            if (stream.closedWith() === undefined) stream.close();
        });
    }

    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        const hello = createClientHelloBuffer({ maxBytes: MAX_CLIENT_HELLO_BYTES });
        const onData = (chunk: Buffer): void => {
            const parsed = hello.push(chunk);
            if (parsed.kind === 'need-more') return;
            socket.off('data', onData);
            if (parsed.kind !== 'sni' || !routable.has(parsed.hostname as Hostname)) {
                refused++;
                socket.destroy();
                return;
            }
            pipe(socket, hello.bytes().slice());
        };
        socket.on('data', onData);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    return {
        port,
        refused: () => refused,
        async close() {
            for (const socket of sockets) socket.destroy();
            server.close();
            await once(server, 'close');
        },
    };
}
