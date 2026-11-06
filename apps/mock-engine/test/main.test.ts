import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EngineId } from '@ptbk/protocol';
import { Hostname, RelayId, defaultHostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createFsIdentityStore } from '../src/adapters/fs-identity-store';
import { operatorSocketDir, operatorSocketPath } from '../src/adapters/operator-socket';
import { startConnectProxy } from '../src/testing/connect-proxy';
import type { FakeDashboard } from '../src/testing/fake-dashboard';
import { createFakeDashboard } from '../src/testing/fake-dashboard';
import { systemClock } from '../src/adapters/system-clock';
import { startFakeRelay } from '../src/testing/fake-relay';
import { createTestCa } from '../src/testing/test-pki';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const RELAY = RelayId.parse('relay-a.ptbk.test');
const PROXY_PASSWORD = 'process-proxy-password';
// Each test starts a Node process with tsx; the first start compiles on the fly.
const PROCESS_TIMEOUT_MS = 30_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'm01-main-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

/** Runs an entry point from source, with only the given environment (nothing leaks in from the test runner). */
function run(entry: string, env: Record<string, string>, args: readonly string[] = []) {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
        cwd: APP_DIR,
        env: { PATH: process.env['PATH'] ?? '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const outputWaiters = new Set<{ text: string; resolve: () => void }>();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        for (const waiter of [...outputWaiters]) {
            if (stdout.includes(waiter.text)) {
                outputWaiters.delete(waiter);
                waiter.resolve();
            }
        }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const exited = once(child, 'exit').then(([code]) => code as number | null);
    cleanups.push(async () => {
        if (child.exitCode === null) child.kill('SIGKILL');
        await exited;
    });
    const printed = (text: string): Promise<void> =>
        stdout.includes(text) ? Promise.resolve() : new Promise((resolve) => outputWaiters.add({ text, resolve }));
    return { child, exited, printed, stdout: () => stdout, stderr: () => stderr };
}

describe('identity CLI', () => {
    it(
        'prints the engine ID, public key and hostname, creating the identity once',
        async () => {
            const dataDir = join(await tempDir(), 'data');
            const env = { PTBK_DATA_DIR: dataDir, PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN, PTBK_RELAYS: 'ignored' };
            const first = run('src/identity.ts', env);
            expect(await first.exited).toBe(0);
            const printed = JSON.parse(first.stdout()) as Record<string, string>;
            const identity = await createFsIdentityStore(dataDir).loadOrCreate();
            expect(printed).toEqual({
                engineId: identity.engineId,
                enginePublicKey: Buffer.from(identity.publicKey).toString('base64url'),
                hostname: defaultHostname(identity.engineId, ENGINE_DOMAIN),
            });
            const second = run('src/identity.ts', env);
            expect(await second.exited).toBe(0);
            expect(second.stdout()).toBe(first.stdout());
        },
        PROCESS_TIMEOUT_MS,
    );

    it(
        'fails with the problem and exit code 1 on bad configuration',
        async () => {
            const failed = run('src/identity.ts', { PTBK_ENGINE_DOMAIN: 'not a domain' });
            expect(await failed.exited).toBe(1);
            expect(failed.stderr()).toContain('PTBK_DATA_DIR');
            expect(failed.stdout()).toBe('');
        },
        PROCESS_TIMEOUT_MS,
    );
});

describe('mock engine process', () => {
    it(
        'opens the tunnel through the proxy with the extra CA and closes it cleanly on SIGTERM',
        async () => {
            const dir = await tempDir();
            const dataDir = join(dir, 'data');
            const identity = await createFsIdentityStore(dataDir).loadOrCreate();
            const hostname = defaultHostname(identity.engineId, ENGINE_DOMAIN);
            const ca = createTestCa('M-01 process test CA');
            const caFile = join(dir, 'relay-ca.pem');
            await writeFile(caFile, ca.certPem);
            const relay = await startFakeRelay({
                relayId: RELAY,
                tls: ca.issue([RELAY]),
                registry: (engineId: EngineId) =>
                    engineId === identity.engineId
                        ? { publicKey: identity.publicKey, hostnames: [hostname] }
                        : undefined,
            });
            cleanups.push(() => relay.close());
            const proxy = await startConnectProxy({
                resolve: () => '127.0.0.1',
                requireAuth: { username: 'engine', password: PROXY_PASSWORD },
            });
            cleanups.push(() => proxy.close());

            const engine = run('src/main.ts', {
                PTBK_DATA_DIR: dataDir,
                PTBK_RELAYS: relay.url,
                PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN,
                HTTPS_PROXY: `http://engine:${PROXY_PASSWORD}@127.0.0.1:${String(proxy.port)}`,
                MOCK_EXTRA_CA_FILE: caFile,
            });
            const session = await relay.waitForSession();
            expect(session.engineId).toBe(identity.engineId);
            await engine.printed('"event":"tunnel.ready"');
            expect(proxy.requests).toEqual([{ target: `${RELAY}:${String(relay.port)}`, hadAuth: true, status: 200 }]);

            engine.child.kill('SIGTERM');
            expect(await engine.exited).toBe(0);
            expect(await session.closed).toBe(1001);
            const events = engine
                .stdout()
                .trim()
                .split('\n')
                .map((line) => (JSON.parse(line) as { event: string }).event);
            expect(events).toEqual(expect.arrayContaining(['engine.started', 'tunnel.ready', 'engine.stopping']));
            expect(engine.stdout()).not.toContain(PROXY_PASSWORD);
        },
        PROCESS_TIMEOUT_MS,
    );

    it(
        'exits with code 1 and names the setting when the configuration is invalid',
        async () => {
            const failed = run('src/main.ts', { PTBK_DATA_DIR: '/nonexistent', PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN });
            expect(await failed.exited).toBe(1);
            expect(JSON.parse(failed.stdout())).toMatchObject({ level: 'error', event: 'engine.start-failed' });
            expect(failed.stdout()).toContain('PTBK_RELAYS');
        },
        PROCESS_TIMEOUT_MS,
    );
});

/** The fake dashboard behind real HTTPS on localhost, trusted through `MOCK_EXTRA_CA_FILE`. */
async function startHttpsDashboard(dir: string): Promise<{ dashboard: FakeDashboard; url: string; caFile: string }> {
    const ca = createTestCa('M-06 dashboard CA');
    const caFile = join(dir, 'dashboard-ca.pem');
    await writeFile(caFile, ca.certPem);
    const dashboard = createFakeDashboard({
        clock: systemClock,
        engineDomain: ENGINE_DOMAIN,
        relays: [Hostname.parse('relay-x.ptbk.test')],
    });
    const leaf = ca.issue(['localhost']);
    const server = createServer({ cert: leaf.certPem, key: leaf.keyPem }, (request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(request.headers)) {
                if (typeof value === 'string') headers.set(name, value);
            }
            void dashboard
                .fetch(`https://localhost${request.url ?? '/'}`, {
                    method: request.method ?? 'GET',
                    headers,
                    body: Buffer.concat(chunks),
                })
                .then(async (answer) => {
                    response.writeHead(answer.status, Object.fromEntries(answer.headers));
                    response.end(Buffer.from(await answer.arrayBuffer()));
                });
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(async () => {
        server.closeAllConnections();
        server.close();
        await once(server, 'close');
    });
    return { dashboard, url: `https://localhost:${String((server.address() as AddressInfo).port)}`, caFile };
}

async function freePort(): Promise<number> {
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

describe('a refused start', () => {
    it(
        'exits non-zero even with listeners already open, here for an operator socket directory others can enter',
        async () => {
            const dataDir = join(await tempDir(), 'data');
            const socketDir = operatorSocketDir(dataDir);
            await mkdir(socketDir, { mode: 0o755 });
            await chmod(socketDir, 0o755);
            cleanups.push(() => rm(socketDir, { recursive: true, force: true }));
            const engine = run('src/main.ts', {
                PTBK_DATA_DIR: dataDir,
                PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN,
                PTBK_RELAYS: `wss://${RELAY}:1`,
                MOCK_CONTROL: 'enabled',
                MOCK_CONTROL_PORT: String(await freePort()),
            });
            expect(await engine.exited).toBe(1);
            expect(engine.stdout()).toContain('"event":"engine.start-failed"');
            expect(engine.stdout()).toContain('operator socket directory');
        },
        PROCESS_TIMEOUT_MS,
    );
});

describe('register command and dashboard mode', () => {
    it(
        'registers once over HTTPS, never writes the link code down, then beats from the stored registration',
        async () => {
            const dir = await tempDir();
            const dataDir = join(dir, 'data');
            const { dashboard, url, caFile } = await startHttpsDashboard(dir);
            const code = dashboard.issueLinkCode('org-a');
            const env = {
                PTBK_DATA_DIR: dataDir,
                PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN,
                PTBK_DASHBOARD_URL: url,
                MOCK_EXTRA_CA_FILE: caFile,
            };
            const first = run('src/main.ts', env, ['register', '--link', code]);
            expect(await first.exited).toBe(0);
            const identity = await createFsIdentityStore(dataDir).loadOrCreate();
            expect(JSON.parse(first.stdout())).toEqual({
                outcome: 'registered',
                engineId: identity.engineId,
                hostname: defaultHostname(identity.engineId, ENGINE_DOMAIN),
                relays: ['relay-x.ptbk.test'],
            });
            const again = run('src/main.ts', env, ['register', '--link', code]);
            expect(await again.exited).toBe(0);
            expect(JSON.parse(again.stdout())).toMatchObject({ outcome: 'already-registered' });
            expect(dashboard.registerRequests).toHaveLength(1);
            for (const name of await readdir(dataDir)) {
                if (name === 'dev-ca') continue;
                expect(await readFile(join(dataDir, name), 'utf8')).not.toContain(code);
            }
            expect(first.stdout() + first.stderr() + again.stdout() + again.stderr()).not.toContain(code);

            const engine = run('src/main.ts', { ...env, MOCK_HEARTBEAT_INTERVAL_S: '1' });
            await engine.printed('"event":"registration.already-registered"');
            const deadline = Date.now() + 20_000;
            while (dashboard.heartbeats.filter((beat) => beat.verification.kind === 'accepted').length < 2) {
                if (Date.now() > deadline) throw new Error('no heartbeats');
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            expect(Number((await readFile(join(dataDir, 'heartbeat-seq'), 'utf8')).trim())).toBeGreaterThan(0);
            engine.child.kill('SIGTERM');
            expect(await engine.exited).toBe(0);
        },
        PROCESS_TIMEOUT_MS,
    );

    it(
        'links with the link URL alone, then starts again from the dashboard stored with the registration',
        async () => {
            const dir = await tempDir();
            const dataDir = join(dir, 'data');
            const { dashboard, url, caFile } = await startHttpsDashboard(dir);
            const code = dashboard.issueLinkCode('org-a');
            const linkUrl = `${url}/link#${code}`;
            const env = { PTBK_DATA_DIR: dataDir, PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN, MOCK_EXTRA_CA_FILE: caFile };

            const unlinked = run('src/main.ts', env);
            expect(await unlinked.exited).toBe(1);
            expect(unlinked.stdout()).toContain('PTBK_DASHBOARD_URL: is required until the engine is linked');

            const conflicting = run('src/main.ts', { ...env, PTBK_DASHBOARD_URL: 'https://localhost:1' }, [
                'connect',
                '--link',
                linkUrl,
            ]);
            expect(await conflicting.exited).toBe(1);
            expect(conflicting.stderr()).toContain('but the link URL is for');
            expect(dashboard.registerRequests).toHaveLength(0);

            const connect = run('src/main.ts', env, ['connect', '--link', linkUrl]);
            expect(await connect.exited).toBe(0);
            expect(connect.stdout()).toContain(`… Linking with the Promptbook dashboard at ${url}\n`);
            expect(connect.stdout()).toContain('✓ Linked to your Promptbook account');
            expect(connect.stdout() + connect.stderr() + conflicting.stderr()).not.toContain(code);
            for (const name of await readdir(dataDir)) {
                if (name === 'dev-ca') continue;
                expect(await readFile(join(dataDir, name), 'utf8')).not.toContain(code);
            }

            const engine = run('src/main.ts', { ...env, MOCK_HEARTBEAT_INTERVAL_S: '1' });
            await engine.printed('"event":"registration.already-registered"');
            const deadline = Date.now() + 20_000;
            while (!dashboard.heartbeats.some((beat) => beat.verification.kind === 'accepted')) {
                if (Date.now() > deadline) throw new Error('no heartbeats');
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            engine.child.kill('SIGTERM');
            expect(await engine.exited).toBe(0);
        },
        PROCESS_TIMEOUT_MS * 2,
    );

    it(
        'waits unlinked, joins on connect, reports status over the operator socket and refuses a second engine',
        async () => {
            const dir = await tempDir();
            const dataDir = join(dir, 'data');
            const { dashboard, url, caFile } = await startHttpsDashboard(dir);
            const env = {
                PTBK_DATA_DIR: dataDir,
                PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN,
                PTBK_DASHBOARD_URL: url,
                MOCK_EXTRA_CA_FILE: caFile,
            };
            const engine = run('src/main.ts', env);
            await engine.printed('"event":"engine.not-linked"');
            expect(engine.stdout()).toContain('"event":"operator.listening"');
            const before = run('src/main.ts', env, ['status', '--json']);
            expect(await before.exited).toBe(0);
            expect(JSON.parse(before.stdout())).toMatchObject({ running: true, mode: 'local', relays: [] });

            const second = run('src/main.ts', env);
            expect(await second.exited).toBe(1);
            expect(second.stdout()).toContain('another engine is running from this data directory');

            const code = dashboard.issueLinkCode('org-a');
            const connect = run('src/main.ts', env, ['connect', '--link', code]);
            expect(await connect.exited).toBe(0);
            expect(connect.stdout()).toContain('✓ The running engine is linked and connects to 1 relay');
            const after = run('src/main.ts', env, ['status']);
            expect(await after.exited).toBe(0);
            expect(after.stdout()).toContain(`Link          linked to ${url}`);
            expect(after.stdout()).toContain('Relays        0 of 1 connected');
            expect(engine.stdout() + connect.stdout() + after.stdout()).not.toContain(code);

            engine.child.kill('SIGTERM');
            expect(await engine.exited).toBe(0);
            expect(existsSync(operatorSocketPath(dataDir))).toBe(false);
            const stopped = run('src/main.ts', env, ['status']);
            expect(await stopped.exited).toBe(1);
            expect(stopped.stderr()).toContain('The engine is not running');
        },
        PROCESS_TIMEOUT_MS * 2,
    );

    it(
        'connects with human lines, and exits 3 for a refused code with the next step',
        async () => {
            const dir = await tempDir();
            const { dashboard, url, caFile } = await startHttpsDashboard(dir);
            const env = {
                PTBK_DATA_DIR: join(dir, 'data'),
                PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN,
                PTBK_DASHBOARD_URL: url,
                MOCK_EXTRA_CA_FILE: caFile,
            };
            const refused = run('src/main.ts', env, ['connect', '--link', 'abcdefghijklmnopqrstuvwxya']);
            expect(await refused.exited).toBe(3);
            expect(refused.stdout()).toContain('✓ Engine key ready');
            expect(refused.stdout()).toContain('✗ The link code was not accepted.');
            const linked = run('src/main.ts', env, ['connect', '--link', dashboard.issueLinkCode('org-a')]);
            expect(await linked.exited).toBe(0);
            expect(linked.stdout()).toContain('✓ Linked to your Promptbook account');
        },
        PROCESS_TIMEOUT_MS,
    );

    it(
        'exits with the usage code on a bad link code without echoing it',
        async () => {
            const dir = await tempDir();
            const failed = run(
                'src/main.ts',
                {
                    PTBK_DATA_DIR: join(dir, 'data'),
                    PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN,
                    PTBK_DASHBOARD_URL: 'https://localhost:1',
                },
                ['register', '--link', 'not-a-real-code'],
            );
            expect(await failed.exited).toBe(2);
            expect(failed.stderr()).toContain('--link must be the link URL the dashboard shows, or its link code');
            expect(failed.stderr() + failed.stdout()).not.toContain('not-a-real-code');
        },
        PROCESS_TIMEOUT_MS,
    );
});
