import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { EngineId } from '@ptbk/protocol';

import type { EngineRegistry } from '../domain/engine-registry';

export const TEST_RELAY_TOKEN = `ptbk_rt_${'A'.repeat(43)}`;

/** One `PUT /internal/v1/relays/presence` as received. */
export interface PresenceRequest {
    readonly authorization: string | undefined;
    readonly contentType: string | undefined;
    /** The body exactly as sent. */
    readonly text: string;
}

export interface FakeDashboard {
    /** Base URL on 127.0.0.1, for `RELAY_REGISTRY_URL`. */
    readonly url: string;
    /** Requests that reached the registry path. */
    readonly requests: () => number;
    /** Authorization headers as received. */
    readonly authorizations: readonly (string | undefined)[];
    /** Presence reports that reached the presence path, oldest first. */
    readonly presence: readonly PresenceRequest[];
    /** What the presence path answers a valid key from now on; 204 by default. */
    setPresenceStatus(status: number): void;
    close(): Promise<void>;
}

const PATH = /^\/internal\/v1\/engines\/([^/]+)$/;
const PRESENCE_PATH = '/internal/v1/relays/presence';

/**
 * The dashboard's registry endpoint over real HTTP, answering from `source`: `found` is 200 with the entry, `not-found`
 * 404, an unavailable or failing source 503. Presence reports (R-07) are recorded and answered with the configured
 * status. A wrong relay key is 401, as the dashboard answers it.
 */
export async function startFakeDashboard(
    source: EngineRegistry,
    options: { readonly token?: string; readonly extraField?: boolean } = {},
): Promise<FakeDashboard> {
    const token = options.token ?? TEST_RELAY_TOKEN;
    const authorizations: (string | undefined)[] = [];
    let requests = 0;
    const presence: PresenceRequest[] = [];
    let presenceStatus = 204;
    const server: Server = createServer((req, res) => {
        if (req.method === 'PUT' && req.url === PRESENCE_PATH) {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                presence.push({
                    authorization: req.headers.authorization,
                    contentType: req.headers['content-type'],
                    text: Buffer.concat(chunks).toString('utf8'),
                });
                res.writeHead(req.headers.authorization === `Bearer ${token}` ? presenceStatus : 401).end();
            });
            return;
        }
        const match = PATH.exec(req.url ?? '');
        const engineId = EngineId.safeParse(match?.[1]);
        if (req.method !== 'GET' || !engineId.success) {
            res.writeHead(404).end();
            return;
        }
        requests++;
        authorizations.push(req.headers.authorization);
        if (req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(401).end();
            return;
        }
        source.lookup(engineId.data, new AbortController().signal).then(
            (lookup) => {
                switch (lookup.kind) {
                    case 'found': {
                        const body = options.extraField === true ? { ...lookup.entry, addedLater: 1 } : lookup.entry;
                        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
                        return;
                    }
                    case 'not-found':
                        res.writeHead(404).end();
                        return;
                    case 'unavailable':
                        res.writeHead(503).end();
                        return;
                }
            },
            () => res.writeHead(503).end(),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${String(port)}`,
        requests: () => requests,
        authorizations,
        presence,
        setPresenceStatus(status) {
            presenceStatus = status;
        },
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => {
                    resolve();
                });
            }),
    };
}
