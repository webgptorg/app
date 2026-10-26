import { createServer } from 'node:net';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { LinkAnswer, OperatorApi, OperatorStatus } from '../domain/onboarding/operator-api';
import { createFakeClock } from '../testing/fake-clock';
import { createMemoryLogger } from '../testing/memory-logger';
import { OperatorAnswerError, createOperatorClient } from './operator-client';
import { OPERATOR_SOCKET_FILE, OperatorSocketError, operatorSocketPath, startOperatorSocket } from './operator-socket';

const STATUS: OperatorStatus = {
    engineId: 'k5dq4tabcdefghijklmnopqrst',
    hostname: 'k5dq4tabcdefghijklmnopqrst.engines.ptbk.test',
    fingerprint: '7KQ2-M9XD-4TRA-0VHE-PZ3N',
    version: '0.1.0',
    mode: 'local',
    dashboardUrl: null,
    relays: [],
    certificate: null,
    ui: null,
    updatePolicy: 'auto',
    ownerSetUp: false,
    heartbeat: null,
    addressGaps: ['relay', 'certificate'],
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
});

async function dataDir(): Promise<string> {
    // Short on purpose: a Unix socket path holds about 100 bytes.
    const dir = await mkdtemp(join(tmpdir(), 'op-'));
    await chmod(dir, 0o700);
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

function api(overrides: Partial<OperatorApi> = {}): OperatorApi {
    return {
        status: () => STATUS,
        link: () => Promise.resolve<LinkAnswer>({ outcome: 'linked', relays: 2 }),
        ...overrides,
    };
}

async function serve(dir: string, operator: OperatorApi = api()) {
    const logger = createMemoryLogger();
    const server = await startOperatorSocket({ dataDir: dir, api: operator, clock: createFakeClock(), logger });
    cleanup.push(() => server.close());
    return { server, logger };
}

function raw(dir: string, method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const outgoing = request({ socketPath: operatorSocketPath(dir), method, path }, (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (text += chunk));
            response.on('end', () => {
                resolve({ status: response.statusCode ?? 0, text });
            });
        });
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}

describe('operator socket', () => {
    it('answers status and link on a 0600 socket in the data directory', async () => {
        const dir = await dataDir();
        const { logger } = await serve(dir);
        expect(((await stat(join(dir, OPERATOR_SOCKET_FILE))).mode & 0o777).toString(8)).toBe('600');
        const client = createOperatorClient(dir);
        expect(await client.status()).toEqual(STATUS);
        expect(await client.link()).toEqual({ outcome: 'linked', relays: 2 });
        expect(logger.entries).toEqual([
            { level: 'info', event: 'operator.listening', fields: { socket: OPERATOR_SOCKET_FILE } },
        ]);
    });

    it('takes no input it does not declare', async () => {
        const dir = await dataDir();
        await serve(dir);
        expect((await raw(dir, 'GET', '/v1/status?verbose=1')).status).toBe(400);
        expect((await raw(dir, 'GET', '/v1/link')).status).toBe(404);
        expect((await raw(dir, 'GET', '/__mock/state')).status).toBe(404);
        const answer = await raw(dir, 'GET', '/v1/status');
        expect(answer.status).toBe(200);
    });

    it('hides an unexpected error behind a problem without internals', async () => {
        const dir = await dataDir();
        const { logger } = await serve(
            dir,
            api({
                status: () => {
                    throw new TypeError('secret detail');
                },
            }),
        );
        const answer = await raw(dir, 'GET', '/v1/status');
        expect(answer.status).toBe(500);
        expect(answer.text).not.toContain('secret detail');
        expect(logger.entries.at(-1)).toEqual({
            level: 'error',
            event: 'operator.error',
            fields: { problem: 'TypeError' },
        });
        await expect(createOperatorClient(dir).status()).rejects.toThrow(OperatorAnswerError);
    });

    it('refuses to start while another engine answers on the same data directory', async () => {
        const dir = await dataDir();
        await serve(dir);
        await expect(serve(dir)).rejects.toThrow(
            new OperatorSocketError(
                `another engine is running from this data directory (${join(dir, OPERATOR_SOCKET_FILE)} answers)`,
            ),
        );
    });

    it('replaces a socket a crashed engine left behind, and refuses a file that is not a socket', async () => {
        const dir = await dataDir();
        const path = join(dir, OPERATOR_SOCKET_FILE);
        // A listener that never answers HTTP stands in for a dead socket file once it is closed.
        const stale = createServer();
        await new Promise<void>((resolve) => stale.listen(path, resolve));
        await new Promise<void>((resolve) => {
            stale.close(() => {
                resolve();
            });
        });
        await writeFile(join(dir, 'placeholder'), '');
        await serve(dir);
        expect(await createOperatorClient(dir).status()).toEqual(STATUS);

        const other = await dataDir();
        await writeFile(join(other, OPERATOR_SOCKET_FILE), 'not a socket');
        await expect(serve(other)).rejects.toThrow(`${join(other, OPERATOR_SOCKET_FILE)} exists and is not a socket`);
    });

    it('removes the socket on close, after which the client finds no engine', async () => {
        const dir = await dataDir();
        const { server } = await serve(dir);
        await server.close();
        cleanup.pop();
        expect(await createOperatorClient(dir).status()).toBeNull();
        expect(await createOperatorClient(dir).link()).toBeNull();
    });

    it('refuses a data directory too long for a socket path', () => {
        expect(() => operatorSocketPath(`/${'d'.repeat(120)}`)).toThrow(OperatorSocketError);
    });
});
