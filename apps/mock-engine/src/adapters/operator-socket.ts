import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, rm, rmdir } from 'node:fs/promises';
import { request } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import type { Logger } from '../domain/logger';
import type { OperatorApi } from '../domain/onboarding/operator-api';
import { createWindowRateLimiter } from '../domain/rate-limit/rate-limiter';
import type { Clock } from '../domain/clock';
import type { PlainHttpServer } from './http/plain-http-server';
import { startPlainHttpServer } from './http/plain-http-server';
import type { HttpRoute } from './http/route';
import { defineHttpRoute } from './http/route';
import { currentUid, ensurePrivateDirectory, lstatOrNull, privacyProblem } from './private-files';

/**
 * `/tmp`, not `os.tmpdir()` or the data directory: a Unix socket path holds at most 103 bytes (104 on macOS with the
 * terminator), and macOS gives every user a temporary directory deep under `/var/folders`.
 */
const SOCKET_ROOT = '/tmp';
export const OPERATOR_SOCKET_FILE = 'op.sock';

export const OPERATOR_PATHS = {
    status: '/v1/status',
    link: '/v1/link',
    setupLink: '/v1/setup-link',
    resetOwner: '/v1/owner/reset',
} as const;

/** The socket cannot be served. Messages name the path and the problem, nothing else. */
export class OperatorSocketError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OperatorSocketError';
    }
}

/**
 * One short directory per data directory, named after a hash of its real path, so the engine and the host's commands
 * find the same socket however long `PTBK_DATA_DIR` is. It is 0700 and the engine user's own; anything else there
 * (another user's directory, a symbolic link, loose modes) is refused, as a socket someone else could plant would
 * answer the operator's commands in the engine's name.
 */
export function operatorSocketDir(dataDir: string): string {
    return join(SOCKET_ROOT, `ptbk-${createHash('sha256').update(canonicalPath(dataDir)).digest('hex').slice(0, 16)}`);
}

/**
 * The real path, also for a data directory the engine has yet to create: its nearest existing ancestor is resolved
 * and the rest appended, so a command run before the first start names the same socket (on macOS `/var` is a link
 * to `/private/var`).
 */
function canonicalPath(path: string): string {
    const missing: string[] = [];
    for (let current = resolve(path); ; current = dirname(current)) {
        try {
            return join(realpathSync(current), ...missing);
        } catch {
            if (dirname(current) === current) return resolve(path);
            missing.unshift(basename(current));
        }
    }
}

export function operatorSocketPath(dataDir: string): string {
    return join(operatorSocketDir(dataDir), OPERATOR_SOCKET_FILE);
}

const SOCKET_DIR_LABEL = 'operator socket directory';

/** The directory's privacy problem, if it exists and is not the engine user's own 0700 directory. */
export async function socketDirProblem(dataDir: string, uid: number | null = currentUid()): Promise<string | null> {
    const path = operatorSocketDir(dataDir);
    const stats = await lstatOrNull(path);
    return stats === null ? null : privacyProblem(stats, { label: SOCKET_DIR_LABEL, path, kind: 'directory' }, uid);
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
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: OPERATOR_PATHS.setupLink,
            auth: 'control',
            permission: null,
            rateLimit: 'control',
            params: null,
            query: NO_QUERY,
            headers: null,
            body: null,
            handle: async () => Response.json(await api.setupLink()),
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: OPERATOR_PATHS.resetOwner,
            auth: 'control',
            permission: null,
            rateLimit: 'control',
            params: null,
            query: NO_QUERY,
            headers: null,
            body: null,
            handle: async () => Response.json(await api.resetOwner()),
        }),
    ];
}

/**
 * The operator channel: HTTP on a Unix socket at `/tmp/ptbk-<hash>/op.sock`, mode 0600, never on the network. A socket
 * left by a crashed engine is replaced; one that still answers means another engine runs from this data directory,
 * and starting would give both the same key, so startup is refused.
 */
export async function startOperatorSocket(deps: {
    readonly dataDir: string;
    readonly api: OperatorApi;
    readonly clock: Clock;
    readonly logger: Logger;
}): Promise<PlainHttpServer> {
    const dir = operatorSocketDir(deps.dataDir);
    const problem = await ensurePrivateDirectory(
        { label: SOCKET_DIR_LABEL, path: dir, kind: 'directory' },
        currentUid(),
    );
    if (problem !== null) throw new OperatorSocketError(problem);
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
    // The directory is 0700 already; the mode keeps the socket private even so.
    await chmod(path, 0o600);
    deps.logger.info('operator.listening', { socket: OPERATOR_SOCKET_FILE });
    return {
        port: null,
        close: async () => {
            await server.close();
            await rm(path, { force: true });
            // Best effort: another engine's command may be looking at it, and a leftover empty directory is harmless.
            await rmdir(dir).catch(() => undefined);
        },
    };
}
