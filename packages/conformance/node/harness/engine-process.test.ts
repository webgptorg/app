import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngineProcess, liveEngineGroups } from './engine-process';

let dir: string;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ptbk-engine-process-'));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

function engine(command: string, env: Record<string, string> = {}) {
    return createEngineProcess({ command: { command, cwd: dir }, dataDir: join(dir, 'data'), env, stopGraceMs: 300 });
}

describe('createEngineProcess', () => {
    it('captures output, reports its own exit and can be started again', async () => {
        const process = engine('echo "out $GREETING"; echo err >&2; exit 4', { GREETING: 'hi', PATH: '/usr/bin:/bin' });
        expect(await process.stop()).toBeNull();
        expect(await process.waitForExit(10)).toBeNull();
        await process.start();
        expect(process.starts).toBe(1);
        expect(process.startedAt).not.toBeNull();
        const exit = await process.waitForExit(5000);
        expect(exit).toMatchObject({ code: 4, signal: null });
        expect(process.running).toBe(false);
        expect(process.logs()).toContain('out hi');
        expect(process.logs()).toContain('err');
        expect(await process.waitForExit(10)).toBe(exit);
        expect(await process.stop()).toBe(exit);
    });

    it('stops with SIGTERM and restarts with a patched environment in the same data directory', async () => {
        const process = engine('echo "run $A $B"; exec sleep 600', { A: 'one', B: 'two', PATH: '/usr/bin:/bin' });
        await process.start();
        await process.start();
        expect(process.running).toBe(true);
        await expect.poll(() => process.logs()).toContain('run one two');
        expect(await process.waitForExit(50)).toBeNull();
        await process.restart({ A: 'three', B: null });
        expect(process.env).toEqual({ A: 'three', PATH: '/usr/bin:/bin' });
        expect(process.starts).toBe(2);
        expect(process.dataDir).toBe(join(dir, 'data'));
        await expect.poll(() => process.logs()).toContain('run three');
        expect(process.logs()).toContain('run one two');
        const exit = await process.stop();
        expect(exit?.signal).toBe('SIGTERM');
        expect(process.exits).toHaveLength(2);
    });

    it('kills the whole process group, also what ignores SIGTERM or outlives the shell', async () => {
        const process = engine("trap '' TERM; (trap '' TERM; exec sleep 600) & sleep 600 & wait", {
            PATH: '/usr/bin:/bin',
        });
        await process.start();
        expect(liveEngineGroups()).toHaveLength(1);
        await process.stop();
        expect(liveEngineGroups()).toEqual([]);
    });

    it('waits for a child that keeps running after the shell exited', async () => {
        const process = engine('(trap "" TERM; exec sleep 600) & exit 0', { PATH: '/usr/bin:/bin' });
        await process.start();
        await process.waitForExit(5000);
        expect(liveEngineGroups()).toHaveLength(1);
        await process.stop();
        expect(liveEngineGroups()).toEqual([]);
    });

    it('kills its engines when the harness itself is ended by SIGTERM', async () => {
        const harness = spawn(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import { createEngineProcess } from ${JSON.stringify(new URL('./engine-process.ts', import.meta.url).href)};
                const engine = createEngineProcess({ command: { command: 'exec sleep 600', cwd: '/' }, dataDir: '/', env: {} });
                await engine.start();
                process.stdout.write(String(engine.starts));
                setInterval(() => {}, 1000);`,
            ],
            { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        await new Promise((resolve) => harness.stdout.once('data', resolve));
        const groups = execFileSync('ps', ['-o', 'pgid=', '-o', 'command=', '-A'], { encoding: 'utf8' })
            .split('\n')
            .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
            .filter((match) => match?.[2] === 'sleep 600')
            .map((match) => Number(match?.[1]));
        expect(groups).toHaveLength(1);
        harness.kill('SIGTERM');
        const exit = await new Promise<NodeJS.Signals | null>((resolve) =>
            harness.once('exit', (_code, signal) => {
                resolve(signal);
            }),
        );
        expect(exit).toBe('SIGTERM');
        await expect
            .poll(() =>
                groups.filter((pgid) => {
                    try {
                        process.kill(-pgid, 0);
                        return true;
                    } catch {
                        return false;
                    }
                }),
            )
            .toEqual([]);
    });

    it('rejects a start that cannot spawn', async () => {
        const process = createEngineProcess({
            command: { command: 'true', cwd: join(dir, 'missing') },
            dataDir: dir,
            env: {},
        });
        await expect(process.start()).rejects.toThrow();
        expect(process.running).toBe(false);
    });

    it('stops waiting for an exit when the signal aborts', async () => {
        const process = engine('exec sleep 600', { PATH: '/usr/bin:/bin' });
        await process.start();
        const controller = new AbortController();
        const waiting = process.waitForExit(60_000, controller.signal);
        controller.abort();
        expect(await waiting).toBeNull();
        await process.stop();
    });
});
