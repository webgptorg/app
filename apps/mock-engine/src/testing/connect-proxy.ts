import { once } from 'node:events';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';

export interface ConnectProxyOptions {
    /** Maps the requested host to the address the proxy dials (tests: every `*.test` name to 127.0.0.1). */
    readonly resolve: (host: string) => string;
    /** When set, a `CONNECT` without exactly these Basic credentials is answered with 407. */
    readonly requireAuth?: { readonly username: string; readonly password: string };
}

export interface ConnectRecord {
    /** `host:port` as requested. */
    readonly target: string;
    readonly hadAuth: boolean;
    readonly status: number;
}

export interface ConnectProxy {
    readonly host: string;
    readonly port: number;
    readonly requests: readonly ConnectRecord[];
    close(): Promise<void>;
}

/** A minimal in-test HTTP `CONNECT` proxy on 127.0.0.1, port 0. */
export async function startConnectProxy(options: ConnectProxyOptions): Promise<ConnectProxy> {
    const requests: ConnectRecord[] = [];
    const sockets = new Set<net.Socket>();
    const server = http.createServer((_request, response) => {
        response.writeHead(405).end();
    });
    const expectedAuth =
        options.requireAuth === undefined
            ? undefined
            : `Basic ${Buffer.from(`${options.requireAuth.username}:${options.requireAuth.password}`).toString('base64')}`;
    server.on('connection', (socket: net.Socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
        const target = request.url ?? '';
        const auth = request.headers['proxy-authorization'];
        const record = (status: number): void => {
            requests.push({ target, hadAuth: auth !== undefined, status });
        };
        client.on('error', () => undefined);
        if (expectedAuth !== undefined && auth !== expectedAuth) {
            record(407);
            client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
            return;
        }
        const separator = target.lastIndexOf(':');
        const upstream = net.connect({
            host: options.resolve(target.slice(0, separator)),
            port: Number(target.slice(separator + 1)),
        });
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        upstream.once('connect', () => {
            record(200);
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    return {
        host: '127.0.0.1',
        port,
        requests,
        async close() {
            for (const socket of sockets) socket.destroy();
            server.close();
            await once(server, 'close');
        },
    };
}
