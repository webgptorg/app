import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The production bundle, run from a directory with no node_modules (the `test` script builds it first).
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const TOKEN = `ptbk_rt_${'s'.repeat(43)}`;

interface RunningRelay {
    readonly lines: () => readonly Record<string, unknown>[];
    readonly output: () => string;
    readonly waitFor: (event: string) => Promise<void>;
    readonly exited: Promise<number | null>;
    readonly kill: (signal: NodeJS.Signals) => void;
}

function run(cwd: string, env: Record<string, string>): RunningRelay {
    // Only the relay's settings: the bundle must not depend on anything else in the environment.
    const child = spawn(process.execPath, ['main.mjs'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const waiters: (() => void)[] = [];
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        for (const wake of waiters.splice(0)) wake();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const lines = () =>
        stdout
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    return {
        lines,
        output: () => stdout + stderr,
        exited,
        kill: (signal) => child.kill(signal),
        async waitFor(event) {
            while (!lines().some((line) => line['event'] === event)) {
                const next = new Promise<void>((resolve) => waiters.push(resolve));
                if ((await Promise.race([next.then(() => 'data'), exited.then(() => 'exit')])) === 'exit') {
                    throw new Error(`relay exited before ${event}: ${stdout}${stderr}`);
                }
            }
        },
    };
}

describe('dist/main.mjs', () => {
    let dir: string;
    let env: Record<string, string>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'relay-dist-'));
        await copyFile(join(DIST, 'main.mjs'), join(dir, 'main.mjs'));
        await writeFile(join(dir, 'registry.json'), JSON.stringify({ v: 1, engines: [] }));
        env = {
            RELAY_HOSTNAME: 'relay-a.ptbk.test',
            RELAY_LISTEN_PORT: '0',
            RELAY_ENGINE_DOMAIN: 'engine.test',
            RELAY_TLS_CERT_FILE: join(dir, 'cert.pem'),
            RELAY_TLS_KEY_FILE: join(dir, 'key.pem'),
            RELAY_REGISTRY_KIND: 'static',
            RELAY_REGISTRY_FILE: join(dir, 'registry.json'),
        };
    });
    afterEach(async () => {
        await rm(dir, { recursive: true });
    });

    it('logs relay.started, keeps running and exits cleanly on SIGTERM', async () => {
        const relay = run(dir, env);
        await relay.waitFor('relay.started');
        relay.kill('SIGTERM');
        await expect(relay.exited).resolves.toBe(0);
        expect(relay.lines().map((line) => line['event'])).toEqual([
            'registry.loaded',
            'relay.started',
            'relay.stopping',
            'relay.stopped',
        ]);
    });

    it('exits cleanly on SIGINT', async () => {
        const relay = run(dir, env);
        await relay.waitFor('relay.started');
        relay.kill('SIGINT');
        await expect(relay.exited).resolves.toBe(0);
    });

    it('exits with 1 and a readable problem on invalid config, never printing the token', async () => {
        const relay = run(dir, {
            ...env,
            RELAY_REGISTRY_KIND: 'http',
            RELAY_REGISTRY_FILE: '',
            RELAY_REGISTRY_TOKEN: TOKEN,
            RELAY_LISTEN_PORT: '70000',
        });
        await expect(relay.exited).resolves.toBe(1);
        expect(relay.lines()).toEqual([
            expect.objectContaining({
                event: 'relay.start-failed',
                problem:
                    'Invalid relay configuration: RELAY_LISTEN_PORT: must be an integer from 0 to 65535; RELAY_REGISTRY_URL: is required',
            }),
        ]);
        expect(relay.output()).not.toContain(TOKEN);
    });

    it('exits with 1 on an invalid registry file', async () => {
        await writeFile(join(dir, 'registry.json'), JSON.stringify({ v: 1, engines: [], note: 'x' }));
        const relay = run(dir, env);
        await expect(relay.exited).resolves.toBe(1);
        expect(relay.lines()[0]).toMatchObject({ event: 'relay.start-failed' });
    });

    it('refuses the http registry until D-04 adds its adapter', async () => {
        const relay = run(dir, {
            ...env,
            RELAY_REGISTRY_KIND: 'http',
            RELAY_REGISTRY_FILE: '',
            RELAY_REGISTRY_URL: 'https://app.ptbk.test',
            RELAY_REGISTRY_TOKEN: TOKEN,
        });
        await expect(relay.exited).resolves.toBe(1);
        const [failure] = relay.lines();
        expect(failure?.['event']).toBe('relay.start-failed');
        expect(failure?.['problem']).toMatch(/D-04/);
        expect(relay.output()).not.toContain(TOKEN);
    });
});
