import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EngineId } from '@ptbk/protocol';
import { Hostname, RelayId, defaultHostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createFsIdentityStore } from '../src/adapters/fs-identity-store';
import { startConnectProxy } from '../src/testing/connect-proxy';
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
function run(entry: string, env: Record<string, string>) {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
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
