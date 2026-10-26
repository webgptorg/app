import { once } from 'node:events';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';

export interface ConnectProxyOptions {
    /** `host:port` targets the proxy dials, each to `upstreamHost`; anything else gets 403, so it is no open proxy. */
    readonly allowedTargets: readonly string[];
    readonly upstreamHost: string;
    /** A `CONNECT` without exactly these Basic credentials is answered with 407. */
    readonly credentials: { readonly username: string; readonly password: string };
}

export interface ConnectRecord {
    /** `host:port` as requested. */
    readonly target: string;
    readonly authorized: boolean;
    readonly status: number;
}

export interface ConnectProxy {
    /** `http://user:password@127.0.0.1:<port>`, for `HTTPS_PROXY`. */
    readonly url: string;
    readonly requests: readonly ConnectRecord[];
    close(): Promise<void>;
}

/** A minimal HTTP `CONNECT` proxy on 127.0.0.1, in front of the fake relay. */
export async function startConnectProxy(options: ConnectProxyOptions): Promise<ConnectProxy> {
    const requests: ConnectRecord[] = [];
    const sockets = new Set<net.Socket>();
    const allowed = new Set(options.allowedTargets);
    const { username, password } = options.credentials;
    const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const server = http.createServer((_request, response) => {
        response.writeHead(405).end();
    });
    server.on('connection', (socket: net.Socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
        const target = (request.url ?? '').toLowerCase();
        const authorized = request.headers['proxy-authorization'] === expectedAuth;
        const answer = (status: number, line: string): void => {
            requests.push({ target, authorized, status });
            client.end(`HTTP/1.1 ${line}\r\n\r\n`);
        };
        client.on('error', () => undefined);
        if (!authorized) {
            answer(407, '407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="conformance"');
            return;
        }
        if (!allowed.has(target)) {
            answer(403, '403 Forbidden');
            return;
        }
        const upstream = net.connect({
            host: options.upstreamHost,
            port: Number(target.slice(target.lastIndexOf(':') + 1)),
        });
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        upstream.once('connect', () => {
            requests.push({ target, authorized, status: 200 });
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
        url: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${String(port)}`,
        requests,
        async close() {
            for (const socket of sockets) socket.destroy();
            server.close();
            await once(server, 'close').catch(() => undefined);
        },
    };
}
