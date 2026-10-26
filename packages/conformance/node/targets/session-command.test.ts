import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startRegisteredEngine } from '../fakes/dashboard';
import type { EngineProcess } from '../harness/engine-process';
import type { EngineTargetFactory, PlatformSuite } from '../harness/platform';
import { runPlatformConformance } from '../harness/run-platform';
import { SELF_TEST_HEARTBEAT_INTERVAL_S, mockEngineCommand } from '../testing/engines';
import { createMockEngineTargetFactory } from './mock-engine';
import { SessionCommandError, createSessionCommandTargetFactory, parseSessionOutput } from './session-command';

let dir: string;

/** A session command that echoes what it was asked for, as a bearer token. */
const ECHO_SCRIPT = `#!/bin/sh
if [ "$2" = owner ]; then printf '{"bearer":"owner"}'; exit 0; fi
printf '{"bearer":"member-%s"}' "$(printf '%s' "$4" | tr , +)"
`;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ptbk-session-'));
    await writeFile(join(dir, 'echo-session'), ECHO_SCRIPT);
    await writeFile(join(dir, 'failing-session'), '#!/bin/sh\nexit 3\n');
    await chmod(join(dir, 'echo-session'), 0o700);
    await chmod(join(dir, 'failing-session'), 0o700);
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

const endpoint = { baseUrl: new URL('https://e.engine.localhost'), fetch };

function targetFor(command: string) {
    const engine = { env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } } as unknown as EngineProcess;
    return createSessionCommandTargetFactory({ command, cwd: process.cwd() }).target(engine, endpoint);
}

describe('parseSessionOutput', () => {
    it('reads a cookie, a bearer token or null', () => {
        expect(parseSessionOutput('{"cookie":"__Host-s=abc"}\n')).toEqual({ cookie: '__Host-s=abc' });
        expect(parseSessionOutput('{"bearer":"tok.en-1"}')).toEqual({ bearer: 'tok.en-1' });
        expect(parseSessionOutput('null')).toBeNull();
    });

    it.each([
        '',
        'nope',
        '[]',
        '{"cookie":"a=b","bearer":"c"}',
        '{"cookie":"a=b; Path=/"}',
        '{"cookie":1}',
        '{"other":"x"}',
    ])('refuses %j', (output) => {
        expect(() => parseSessionOutput(output)).toThrow(SessionCommandError);
    });
});

describe('createSessionCommandTargetFactory', () => {
    it('runs the command with the subject as arguments and the engine environment', async () => {
        const target = targetFor(join(dir, 'echo-session'));
        expect(target.baseUrl).toBe(endpoint.baseUrl);
        expect(await target.session({ kind: 'owner' })).toEqual({ bearer: 'owner' });
        expect(await target.session({ kind: 'member', permissions: ['agents.read', 'chats.read'] })).toEqual({
            bearer: 'member-agents.read+chats.read',
        });
        expect(await target.session({ kind: 'member', permissions: [] })).toEqual({ bearer: 'member-' });
        expect(await targetFor('echo null; true').session({ kind: 'owner' })).toBeNull();
        expect(await createSessionCommandTargetFactory({ command: 'true', cwd: '.' }).engineEnv()).toEqual({});
    });

    it('fails a session when the command fails or prints something else', async () => {
        await expect(targetFor(join(dir, 'failing-session')).session({ kind: 'owner' })).rejects.toThrow(
            'exited with status 3',
        );
        await expect(targetFor('echo nope; true').session({ kind: 'owner' })).rejects.toThrow('did not print JSON');
        await expect(targetFor('true').session({ kind: 'member', permissions: ['x; rm' as never] })).rejects.toThrow(
            'unexpected permission name',
        );
        const missingCwd = createSessionCommandTargetFactory({ command: 'true', cwd: '/nonexistent-ptbk' });
        await expect(
            missingCwd.target({ env: {} } as unknown as EngineProcess, endpoint).session({ kind: 'owner' }),
        ).rejects.toThrow();
    });

    it("gets the mock engine's sessions through its conformance-session command, also after a restart", async () => {
        const mock = mockEngineCommand();
        const sessions = createSessionCommandTargetFactory({
            command: `${mock.command} conformance-session`,
            cwd: mock.cwd,
        });
        // The mock's command asks its dev-only control listener, so each engine gets one, as with --mock-control.
        const mockControl = createMockEngineTargetFactory();
        const targets: EngineTargetFactory = {
            engineEnv: () => mockControl.engineEnv(),
            target: (engine, api) => sessions.target(engine, api),
        };
        const suite: PlatformSuite = {
            id: 'example',
            checks: [
                {
                    id: 'example.sessions.after-restart',
                    suite: 'example',
                    title: 'Sessions come from the engine, before and after a restart',
                    async run(ctx) {
                        const registered = await startRegisteredEngine(ctx);
                        const target = ctx.engineTarget(registered.engine, endpoint);
                        const before = await target?.session({ kind: 'owner' });
                        await registered.restart();
                        const after = await target?.session({ kind: 'member', permissions: ['agents.read'] });
                        const cookies = [before, after].map((credential) =>
                            credential !== null && credential !== undefined && 'cookie' in credential
                                ? credential.cookie
                                : '',
                        );
                        return cookies.every((cookie) => cookie.startsWith('__Host-ptbk_session='))
                            ? { kind: 'pass' }
                            : { kind: 'fail', detail: 'no session cookie' };
                    },
                },
            ],
        };
        const report = await runPlatformConformance({
            command: mock,
            suites: [suite],
            targets,
            timeoutMs: 30_000,
            signal: new AbortController().signal,
            expectations: { heartbeatIntervalMs: SELF_TEST_HEARTBEAT_INTERVAL_S * 1000, startTimeoutMs: 10_000 },
        });
        expect(report.results[0]?.outcome).toEqual({ kind: 'pass' });
    });
});
