import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConformanceTarget, EngineSettings } from '../../../src/index';
import { CheckSkip, runChecks } from '../../../src/index';
import type { RegisteredEngine, RegisteredEngineOptions } from '../../fakes/dashboard';
import type { EngineProcess } from '../../harness/engine-process';
import type { EngineApiEndpoint, PlatformCheckContext } from '../../harness/platform';
import { createTestContext } from '../../testing/context';
import type { EngineEndpoints, EngineRoute } from './endpoints';
import { UI_LOADER_CHECK_TIMEOUT_MS, createUiLoaderPlatformSuite } from './index';
import type { RegisterEngine } from './platform-lab';
import { UI_STORE_HOSTNAME, openPlatformLab } from './platform-lab';

const TRUST = { v: 1, trustPolicy: { marker: 'policy' }, trustedRoot: { marker: 'root' } } as never;
const ENDPOINT: EngineApiEndpoint = { baseUrl: new URL('https://engine-1.engine.localhost/'), fetch };

interface FakeEngine extends RegisteredEngine {
    readonly options: RegisteredEngineOptions;
    readonly restarts: Readonly<Record<string, string | null>>[];
    stopped: number;
}

/** Registered engines as the harness hands them out, recording what the lab asks of them. */
function fakeRegistry(): { readonly register: RegisterEngine; readonly engines: FakeEngine[] } {
    const engines: FakeEngine[] = [];
    const register: RegisterEngine = (_ctx, options) => {
        const restarts: Readonly<Record<string, string | null>>[] = [];
        const lines = Array.from({ length: 50 }, (_, index) => `line ${String(index + 1)}`);
        const fake: FakeEngine = {
            options,
            restarts,
            stopped: 0,
            engine: {
                dataDir: `/data/${String(engines.length + 1)}`,
                logs: () => lines.join('\n'),
                stop: () => {
                    fake.stopped += 1;
                    return Promise.resolve(null);
                },
            } as unknown as EngineProcess,
            dashboard: null as never,
            linkCode: 'link' as never,
            identity: { engineId: `engine${String(engines.length + 1)}` as never, enginePublicKey: 'key' },
            restart: (patch = {}) => {
                restarts.push(patch);
                return Promise.resolve();
            },
            nextAcceptedHeartbeat: () => Promise.reject(new Error('not used')),
        };
        engines.push(fake);
        return Promise.resolve(fake);
    };
    return { register, engines };
}

function routeTo(endpointFor: EngineRoute['endpointFor'] = () => Promise.resolve(ENDPOINT)): EngineRoute & {
    readonly routed: RegisteredEngine[];
} {
    const routed: RegisteredEngine[] = [];
    return {
        env: { PTBK_RELAYS: 'wss://relay.localhost:1234' },
        routed,
        endpointFor(engine) {
            routed.push(engine);
            return endpointFor(engine);
        },
    };
}

function endpointsOf(route: EngineRoute): EngineEndpoints & { prepared: number } {
    const endpoints = {
        prepared: 0,
        prepare: () => {
            endpoints.prepared += 1;
            return Promise.resolve(route);
        },
    };
    return endpoints;
}

const settings = (update: EngineSettings['update']): EngineSettings => ({ update, trust: TRUST });
const pinned = (version: string): EngineSettings => settings({ policy: 'pinned', version });
const signal = new AbortController().signal;

describe('the platform ui-loader lab', () => {
    let ctx: ReturnType<typeof createTestContext>;
    let root: string;
    let targets: { engine: EngineProcess; endpoint: EngineApiEndpoint }[];

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'ui-lab-test-'));
        targets = [];
        const base = createTestContext();
        let dirs = 0;
        ctx = {
            ...base,
            async tempDir(label) {
                const dir = join(root, `${String(++dirs)}-${label}`);
                await mkdir(dir, { mode: 0o700 });
                return dir;
            },
            engineTarget: (engine, endpoint) => {
                targets.push({ engine, endpoint });
                return { baseUrl: endpoint.baseUrl, fetch: endpoint.fetch, session: () => Promise.resolve(null) };
            },
        };
    });
    afterEach(async () => {
        await ctx.closeAll();
        await rm(root, { recursive: true, force: true });
    });

    it('registers the engine on the first start with the route and the update settings', async () => {
        const { register, engines } = fakeRegistry();
        const route = routeTo();
        const lab = await openPlatformLab(ctx, { endpoints: endpointsOf(route), register });
        expect(lab.store.url.hostname).toBe(UI_STORE_HOSTNAME);

        const target = await lab.start(pinned('1.0.1'), { fresh: true, signal });
        expect(target.baseUrl).toBe(ENDPOINT.baseUrl);
        expect(engines).toHaveLength(1);
        const env = engines[0]?.options.env ?? {};
        expect(env).toEqual({
            PTBK_RELAYS: 'wss://relay.localhost:1234',
            PTBK_UI_RELEASE_URL: lab.store.url.href,
            PTBK_CONFORMANCE_TRUST_FILE: env.PTBK_CONFORMANCE_TRUST_FILE,
            PTBK_UPDATE_POLICY: 'pinned',
            PTBK_PINNED_VERSION: '1.0.1',
        });
        const trustFile = env.PTBK_CONFORMANCE_TRUST_FILE ?? '';
        expect(JSON.parse(await readFile(trustFile, 'utf8'))).toEqual(TRUST);
        expect((await stat(trustFile)).mode & 0o777).toBe(0o600);
        expect(route.routed).toEqual([engines[0]]);
        expect(targets.map(({ engine }) => engine)).toEqual([engines[0]?.engine]);
    });

    it('restarts the same engine afterwards, removing the pinned version when the policy changes', async () => {
        const { register, engines } = fakeRegistry();
        const route = routeTo();
        const lab = await openPlatformLab(ctx, { endpoints: endpointsOf(route), register });
        await lab.start(settings({ policy: 'auto' }), { fresh: false, signal });
        expect(engines[0]?.options.env).not.toHaveProperty('PTBK_PINNED_VERSION');
        await lab.start(pinned('1.0.2'), { fresh: false, signal });
        await lab.start(settings({ policy: 'manual' }), { fresh: false, signal });
        expect(engines).toHaveLength(1);
        expect(
            engines[0]?.restarts.map(({ PTBK_UPDATE_POLICY, PTBK_PINNED_VERSION }) => ({
                PTBK_UPDATE_POLICY,
                PTBK_PINNED_VERSION,
            })),
        ).toEqual([
            { PTBK_UPDATE_POLICY: 'pinned', PTBK_PINNED_VERSION: '1.0.2' },
            { PTBK_UPDATE_POLICY: 'manual', PTBK_PINNED_VERSION: null },
        ]);
        // Routed again after every restart, so the target is only handed out once the engine answers.
        expect(route.routed).toHaveLength(3);
    });

    it('registers a new engine on a route of its own for a fresh start, and stops the previous one', async () => {
        const { register, engines } = fakeRegistry();
        const endpoints = endpointsOf(routeTo());
        const lab = await openPlatformLab(ctx, { endpoints, register });
        await lab.start(pinned('1.0.1'), { fresh: false, signal });
        await lab.start(pinned('1.0.3'), { fresh: false, signal });
        expect(endpoints.prepared).toBe(1);
        await lab.start(pinned('1.0.2'), { fresh: true, signal });
        expect(endpoints.prepared).toBe(2);
        expect(engines).toHaveLength(2);
        expect(engines[0]?.stopped).toBe(1);
        expect(engines[1]?.restarts).toEqual([]);
        await lab.close();
        expect(engines[1]?.stopped).toBe(1);
    });

    it('shows the last 40 lines of the engine output, and nothing before a start', async () => {
        const { register } = fakeRegistry();
        const lab = await openPlatformLab(ctx, { endpoints: endpointsOf(routeTo()), register });
        expect(lab.logTail()).toBe('');
        await lab.start(pinned('1.0.1'), { fresh: false, signal });
        const tail = lab.logTail().split('\n');
        expect(tail).toHaveLength(40);
        expect(tail[0]).toBe('line 11');
        expect(tail.at(-1)).toBe('line 50');
    });

    it('skips when the run has no way to get sessions for the engine', async () => {
        const { register } = fakeRegistry();
        const lab = await openPlatformLab(
            { ...ctx, engineTarget: () => null },
            { endpoints: endpointsOf(routeTo()), register },
        );
        await expect(lab.start(pinned('1.0.1'), { fresh: false, signal })).rejects.toThrow(CheckSkip);
    });

    it('refuses to start once the check is aborted', async () => {
        const { register, engines } = fakeRegistry();
        const lab = await openPlatformLab(ctx, { endpoints: endpointsOf(routeTo()), register });
        const aborted = AbortSignal.abort(new Error('check timed out'));
        await expect(lab.start(pinned('1.0.1'), { fresh: false, signal: aborted })).rejects.toThrow('check timed out');
        expect(engines).toHaveLength(0);
    });
});

describe('the ui-loader platform suite', () => {
    const run = (suite: ReturnType<typeof createUiLoaderPlatformSuite>, ctx: PlatformCheckContext) =>
        runChecks<PlatformCheckContext>({
            suites: [suite],
            timeoutMs: 30_000,
            signal,
            seed: 1,
            filter: (check) => check.id === 'ui-loader.install.pinned-valid',
            scope: (base) => ({ context: { ...ctx, ...base }, finish: () => Promise.resolve({}) }),
        });

    it('keeps the check IDs and gives every check a long timeout', () => {
        const suite = createUiLoaderPlatformSuite({ endpoints: null });
        expect(suite.id).toBe('ui-loader');
        expect(suite.checks.length).toBeGreaterThan(20);
        for (const check of suite.checks) {
            expect(check.id.startsWith('ui-loader.')).toBe(true);
            expect(check.suite).toBe('ui-loader');
            expect(
                check.timeoutMs?.({
                    heartbeatIntervalMs: 1,
                    intervalOverridden: false,
                    startTimeoutMs: 1,
                    quietWindowMs: 1,
                }),
            ).toBe(UI_LOADER_CHECK_TIMEOUT_MS);
        }
    });

    it('skips every check without a way to reach the engine API', async () => {
        const report = await run(createUiLoaderPlatformSuite({ endpoints: null }), createTestContext());
        expect(report.results.map((result) => result.outcome)).toEqual([
            { kind: 'skip', reason: 'engine-api-unreachable' },
        ]);
    });

    it('runs a check on a lab of its own and closes it afterwards', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ui-suite-test-'));
        const ctx = createTestContext();
        const { register, engines } = fakeRegistry();
        let prepared = 0;
        try {
            const suite = createUiLoaderPlatformSuite({
                endpoints: {
                    prepare: () => {
                        prepared += 1;
                        return Promise.resolve(routeTo());
                    },
                },
                register,
            });
            const target: ConformanceTarget = { ...ENDPOINT, session: () => Promise.resolve(null) };
            const report = await run(suite, {
                ...ctx,
                tempDir: () => Promise.resolve(root),
                engineTarget: () => target,
            });
            // The fake target has no owner session, so the check stops right after the engine started.
            expect(report.results.map((result) => result.outcome)).toEqual([
                { kind: 'skip', reason: 'needs-owner-session' },
            ]);
            expect(prepared).toBe(1);
            expect(engines[0]?.stopped).toBe(1);
        } finally {
            await ctx.closeAll();
            await rm(root, { recursive: true, force: true });
        }
    });
});
