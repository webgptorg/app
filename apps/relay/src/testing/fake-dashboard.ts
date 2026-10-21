import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { EngineId } from '@ptbk/protocol';

import type { EngineRegistry } from '../domain/engine-registry';

export const TEST_RELAY_TOKEN = `ptbk_rt_${'A'.repeat(43)}`;

export interface FakeDashboard {
    /** Base URL on 127.0.0.1, for `RELAY_REGISTRY_URL`. */
    readonly url: string;
    /** Requests that reached the registry path. */
    readonly requests: () => number;
    /** Authorization headers as received. */
    readonly authorizations: readonly (string | undefined)[];
    close(): Promise<void>;
}

const PATH = /^\/internal\/v1\/engines\/([^/]+)$/;

/**
 * The dashboard's registry endpoint over real HTTP, answering from `source`: `found` is 200 with the entry, `not-found`
 * 404, an unavailable or failing source 503. A wrong relay key is 401, as the dashboard answers it.
 */
export async function startFakeDashboard(
    source: EngineRegistry,
    options: { readonly token?: string; readonly extraField?: boolean } = {},
): Promise<FakeDashboard> {
    const token = options.token ?? TEST_RELAY_TOKEN;
    const authorizations: (string | undefined)[] = [];
    let requests = 0;
    const server: Server = createServer((req, res) => {
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
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => {
                    resolve();
                });
            }),
    };
}
