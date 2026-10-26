import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { Server } from 'node:https';

import type { FakeReleaseStore, StoreFault, StoreRequest } from '../../../src/index';
import { listenLoopback } from '../../harness/loopback';

export interface StoreServerOptions {
    /** A `*.localhost` name the certificate is valid for; the engine resolves it to loopback itself. */
    readonly hostname: string;
    readonly certPem: string;
    readonly keyPem: string;
}

export interface StoreServer extends FakeReleaseStore {
    close(): Promise<void>;
}

const BASE_PATH = '/mirror/';

/**
 * The fake release store over HTTPS on loopback: exactly what `put` stored is served, everything else is 404. Every
 * request under the base path is recorded before it is answered, so a check can tell what the engine fetched after a
 * restart even when the answer was a fault.
 */
export async function openStoreServer(options: StoreServerOptions): Promise<StoreServer> {
    const files = new Map<string, Uint8Array>();
    const faults = new Map<string, StoreFault>();
    const requests: StoreRequest[] = [];
    const servers: Server[] = [];

    function handle(request: IncomingMessage, response: ServerResponse): void {
        const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
        if (!pathname.startsWith(BASE_PATH) || (request.method !== 'GET' && request.method !== 'HEAD')) {
            response.writeHead(404).end();
            return;
        }
        // The raw path, still percent-encoded, as the mirror layout writes artifact names.
        const path = pathname.slice(BASE_PATH.length);
        requests.push({ path, atMs: Date.now() });
        const fault = faults.get(path);
        if (fault === 'error') {
            response.writeHead(503, { 'content-type': 'text/plain' }).end('unavailable');
            return;
        }
        const body = files.get(path);
        if (body === undefined) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'content-type': contentType(path), 'content-length': String(body.byteLength) });
        if (request.method === 'HEAD') {
            response.end();
            return;
        }
        if (fault === 'truncate') {
            // The full length is announced, half is sent, then the connection goes: a store failing mid-transfer.
            response.write(body.subarray(0, Math.floor(body.byteLength / 2)), () => {
                response.socket?.destroy();
            });
            return;
        }
        response.end(body);
    }

    const listener = await listenLoopback(() => {
        const server = createServer({ cert: options.certPem, key: options.keyPem, minVersion: 'TLSv1.2' }, handle);
        servers.push(server);
        return server;
    });
    const url = new URL(`https://${options.hostname}:${String(listener.port)}${BASE_PATH}`);

    return {
        url,
        put(path, body) {
            files.set(path, typeof body === 'string' ? new TextEncoder().encode(body) : body);
        },
        delete(path) {
            files.delete(path);
        },
        fault(path, fault) {
            if (fault === null) faults.delete(path);
            else faults.set(path, fault);
        },
        requests: () => requests,
        async close() {
            for (const server of servers) server.closeAllConnections();
            await listener.close();
        },
    };
}

function contentType(path: string): string {
    return path.endsWith('.json') ? 'application/json' : 'application/octet-stream';
}
