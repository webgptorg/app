import { request } from 'node:http';
import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { Logger } from '../domain/logger';
import type { OperatorApi } from '../domain/onboarding/operator-api';
import { createWindowRateLimiter } from '../domain/rate-limit/rate-limiter';
import type { Clock } from '../domain/clock';
import type { PlainHttpServer } from './http/plain-http-server';
import { startPlainHttpServer } from './http/plain-http-server';
import type { HttpRoute } from './http/route';
import { defineHttpRoute } from './http/route';
import { lstatOrNull } from './private-files';

/** Inside `PTBK_DATA_DIR`, which only the engine's user can enter: reaching the socket is shell access to the host. */
export const OPERATOR_SOCKET_FILE = 'operator.sock';
/** `sun_path` holds 104 bytes on macOS and 108 on Linux, terminator included. */
const MAX_SOCKET_PATH_BYTES = 103;

export const OPERATOR_PATHS = { status: '/v1/status', link: '/v1/link' } as const;

/** The socket cannot be served. Messages name the path and the problem, nothing else. */
export class OperatorSocketError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OperatorSocketError';
    }
}

export function operatorSocketPath(dataDir: string): string {
    const path = join(dataDir, OPERATOR_SOCKET_FILE);
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
        throw new OperatorSocketError(
            `PTBK_DATA_DIR is too long for the operator socket ${path} (at most ${String(MAX_SOCKET_PATH_BYTES)} bytes)`,
        );
    }
    return path;
}

/** Whether something answers on the socket: a running engine. */
export function socketAnswers(path: string): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = request({ socketPath: path, path: OPERATOR_PATHS.status, method: 'GET', timeout: 2_000 });
        probe.on('response', (response) => {
            response.resume();
            resolve(true);
        });
        probe.on('timeout', () => {
            probe.destroy();
            resolve(false);
        });
        probe.on('error', () => {
            resolve(false);
        });
        probe.end();
    });
}

const NO_QUERY = z.strictObject({});

function operatorRoutes(api: OperatorApi): readonly HttpRoute[] {
    return [
        defineHttpRoute({
            transport: 'http',
            method: 'GET',
            path: OPERATOR_PATHS.status,
            auth: 'control',
            permission: null,
            rateLimit: 'control',
            params: null,
            query: NO_QUERY,
            headers: null,
            body: null,
            handle: () => Response.json(api.status()),
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: OPERATOR_PATHS.link,
            auth: 'control',
            permission: null,
            rateLimit: 'control',
            params: null,
            query: NO_QUERY,
            headers: null,
            body: null,
            handle: async () => Response.json(await api.link()),
        }),
    ];
}

/**
 * The operator channel: HTTP on a Unix socket at `<dataDir>/operator.sock`, mode 0600, never on the network. A socket
 * left by a crashed engine is replaced; one that still answers means another engine runs from this data directory,
 * and starting would give both the same key, so startup is refused.
 */
export async function startOperatorSocket(deps: {
    readonly dataDir: string;
    readonly api: OperatorApi;
    readonly clock: Clock;
    readonly logger: Logger;
}): Promise<PlainHttpServer> {
    const path = operatorSocketPath(deps.dataDir);
    const existing = await lstatOrNull(path);
    if (existing !== null) {
        if (!existing.isSocket()) throw new OperatorSocketError(`${path} exists and is not a socket`);
        if (await socketAnswers(path)) {
            throw new OperatorSocketError(`another engine is running from this data directory (${path} answers)`);
        }
        await rm(path, { force: true });
    }
    const server = await startPlainHttpServer({
        routes: operatorRoutes(deps.api),
        rateLimiter: createWindowRateLimiter({ clock: deps.clock }),
        logger: deps.logger,
        errorEvent: 'operator.error',
        listen: { path },
    });
    // The directory is 0700 already; the mode keeps the socket private if the directory is ever loosened.
    await chmod(path, 0o600);
    deps.logger.info('operator.listening', { socket: OPERATOR_SOCKET_FILE });
    return {
        port: null,
        close: async () => {
            await server.close();
            await rm(path, { force: true });
        },
    };
}
