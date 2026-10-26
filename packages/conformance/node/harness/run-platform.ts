import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hostname } from '@ptbk/protocol';
import { Hostname as HostnameSchema } from '@ptbk/protocol';

import type { BaseCheckContext, CheckOutcome, CheckResult, ConformanceReport } from '../../src/index';
import { runChecks } from '../../src/index';
import { createTestCa } from '../pki/test-ca';
import type { EngineCommand, EngineProcess } from './engine-process';
import { createEngineProcess } from './engine-process';
import { engineEnvironment } from './launch-env';
import { LOOPBACK_DOMAIN } from './loopback';
import type {
    Closable,
    EngineTargetFactory,
    PlatformCheck,
    PlatformCheckContext,
    PlatformExpectations,
    PlatformSuite,
} from './platform';
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_QUIET_WINDOW_MS, DEFAULT_START_TIMEOUT_MS } from './platform';

export interface RunPlatformOptions {
    readonly command: EngineCommand;
    readonly suites: readonly PlatformSuite[];
    readonly filter?: (check: PlatformCheck) => boolean;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly seed?: number;
    readonly now?: () => Date;
    readonly onResult?: (result: CheckResult) => void;
    readonly expectations?: Partial<PlatformExpectations>;
    /** How to reach the engine API of each engine; without it, checks that need the API skip. */
    readonly targets?: EngineTargetFactory;
    /** The environment engines inherit, cleaned of proxy, CA and `PTBK_*` variables. Default: this process's. */
    readonly parentEnv?: Readonly<Record<string, string | undefined>>;
    /** Where the run's private directory goes. Default: the OS temporary directory. */
    readonly tempRoot?: string;
    /** How long a stopped engine gets before SIGKILL. Default: the launch contract's 10 s. */
    readonly stopGraceMs?: number;
}

/** The engine domain every engine under test gets; its hostnames resolve to loopback. */
export const HARNESS_ENGINE_DOMAIN: Hostname = HostnameSchema.parse(`engine.${LOOPBACK_DOMAIN}`);

/** Engine output in a failed check's report: the end, where the failure usually is. */
const OUTPUT_TAIL_CHARS = 16 * 1024;
const TEARDOWN_TIMEOUT_MS = 30_000;

/**
 * Runs platform suites: for each check a fresh scope with its own engines, fake servers and directories, all torn
 * down when the check ends, whatever its outcome. A suite fixture gets a scope of its own that lasts until the
 * suite's last check. One ephemeral CA serves the whole run.
 */
export async function runPlatformConformance(options: RunPlatformOptions): Promise<ConformanceReport> {
    const heartbeatIntervalMs = options.expectations?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const expectations: PlatformExpectations = {
        heartbeatIntervalMs,
        intervalOverridden:
            options.expectations?.intervalOverridden ?? heartbeatIntervalMs !== DEFAULT_HEARTBEAT_INTERVAL_MS,
        startTimeoutMs: options.expectations?.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        quietWindowMs: options.expectations?.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS,
    };
    const runDir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'ptbk-conformance-'));
    await chmod(runDir, 0o700);
    const ca = createTestCa('ptbk-conformance test CA', { permittedDomains: [LOOPBACK_DOMAIN] });
    const caFile = join(runDir, 'test-ca.pem');
    await writeFile(caFile, ca.certPem, { mode: 0o600 });
    let checkIndex = 0;
    let dirIndex = 0;
    const suiteFixtures = new Map<string, SuiteFixture>();

    const openScope = (base: BaseCheckContext, dirName: string): HarnessScope => {
        const scopeDir = join(runDir, dirName);
        const engines: EngineProcess[] = [];
        const fixtures: Closable[] = [];
        const tempDir = async (label: string): Promise<string> => {
            await mkdir(scopeDir, { recursive: true, mode: 0o700 });
            const dir = join(scopeDir, `${String(++dirIndex)}-${label.replace(/[^a-z0-9-]/gi, '_')}`);
            await mkdir(dir, { mode: 0o700 });
            return dir;
        };
        const context: PlatformCheckContext = {
            ...base,
            ca,
            engineDomain: HARNESS_ENGINE_DOMAIN,
            expectations,
            tempDir,
            async engine(engineOptions = {}) {
                const dataDir = engineOptions.dataDir ?? join(await tempDir('engine'), 'data');
                const engineSpecific = (await options.targets?.engineEnv()) ?? {};
                const engine = createEngineProcess({
                    command: options.command,
                    dataDir,
                    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
                    env: engineEnvironment(options.parentEnv ?? process.env, engineSpecific, {
                        PTBK_DATA_DIR: dataDir,
                        PTBK_MODE: 'tunnel',
                        PTBK_ENGINE_DOMAIN: HARNESS_ENGINE_DOMAIN,
                        NODE_EXTRA_CA_CERTS: caFile,
                        ...engineOptions.env,
                    }),
                });
                engines.push(engine);
                return engine;
            },
            use(fixture) {
                fixtures.push(fixture);
                return fixture;
            },
            suiteFixture<T>(suite: string, open: (scope: PlatformCheckContext) => Promise<T>) {
                // One fixture per suite, whatever later callers pass as `open`, so its type is the first caller's.
                return suiteFixtureFor(base, suite, open).value as Promise<T>;
            },
            engineTarget: (engine, endpoint) => options.targets?.target(engine, endpoint) ?? null,
            engineCertificateAuthority: (engine) =>
                options.targets?.certificateAuthority?.(engine) ?? Promise.resolve(null),
        };
        return {
            context,
            engines,
            stopEngines: () => Promise.all(engines.map((engine) => engine.stop())).then(() => undefined),
            async close() {
                for (const fixture of fixtures.reverse()) await bounded(fixture.close());
                await removeTree(scopeDir);
            },
        };
    };

    const suiteFixtureFor = (base: BaseCheckContext, suite: string, open: SuiteFixtureOpen): SuiteFixture => {
        const existing = suiteFixtures.get(suite);
        if (existing !== undefined) return existing;
        const cleanups: ((signal: AbortSignal) => Promise<unknown>)[] = [];
        // The run's signal, not the asking check's: the fixture outlives that check, and its timeout.
        const scope = openScope(
            {
                random: base.random,
                runId: base.runId,
                signal: options.signal,
                resources: { defer: (cleanup) => cleanups.push(cleanup) },
            },
            `suite-${suite.replace(/[^a-z0-9-]/gi, '_')}`,
        );
        const fixture: SuiteFixture = {
            scope,
            value: Promise.resolve().then(() => open(scope.context)),
            async close() {
                for (const cleanup of cleanups.reverse()) {
                    await bounded(
                        Promise.resolve()
                            .then(() => cleanup(AbortSignal.timeout(TEARDOWN_TIMEOUT_MS)))
                            .then(() => undefined),
                    );
                }
                await scope.stopEngines();
                await scope.close();
            },
        };
        suiteFixtures.set(suite, fixture);
        return fixture;
    };

    const closeSuiteFixture = async (suite: string): Promise<void> => {
        const fixture = suiteFixtures.get(suite);
        if (fixture === undefined) return;
        suiteFixtures.delete(suite);
        await fixture.value.catch(() => undefined);
        await fixture.close();
    };

    try {
        return await runChecks<PlatformCheckContext>({
            suites: options.suites,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
            ...(options.seed === undefined ? {} : { seed: options.seed }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.onResult === undefined ? {} : { onResult: options.onResult }),
            ...(options.filter === undefined ? {} : { filter: options.filter }),
            timeoutFor: (check) => (check as PlatformCheck).timeoutMs?.(expectations) ?? 0,
            afterSuite: (suite) => closeSuiteFixture(suite.id),
            scope: (base) => {
                const scope = openScope(base, `check-${String(++checkIndex)}`);
                const shared = new Set<SuiteFixture>();
                const context: PlatformCheckContext = {
                    ...scope.context,
                    suiteFixture<T>(suite: string, open: (scope: PlatformCheckContext) => Promise<T>) {
                        const fixture = suiteFixtureFor(base, suite, open);
                        shared.add(fixture);
                        return fixture.value as Promise<T>;
                    },
                };
                return {
                    context,
                    async finish(outcome: CheckOutcome) {
                        await scope.stopEngines();
                        const engineOutput =
                            outcome.kind === 'fail'
                                ? outputOf([
                                      ...scope.engines.map((engine) => ({ engine, label: '' })),
                                      ...[...shared].flatMap((fixture) =>
                                          fixture.scope.engines.map((engine) => ({
                                              engine,
                                              label: ', shared by the suite',
                                          })),
                                      ),
                                  ])
                                : undefined;
                        await scope.close();
                        return engineOutput === undefined ? {} : { engineOutput };
                    },
                };
            },
        });
    } finally {
        for (const suite of [...suiteFixtures.keys()]) await closeSuiteFixture(suite);
        await removeTree(runDir);
    }
}

type SuiteFixtureOpen = (scope: PlatformCheckContext) => Promise<unknown>;

interface HarnessScope {
    readonly context: PlatformCheckContext;
    readonly engines: readonly EngineProcess[];
    stopEngines(): Promise<void>;
    /** Closes the scope's fixtures, newest first, and removes its directories. */
    close(): Promise<void>;
}

interface SuiteFixture extends Closable {
    readonly scope: HarnessScope;
    readonly value: Promise<unknown>;
}

/**
 * `rm -r` that also empties directories the engine made read-only, as the mock does with unpacked UI bundles: a
 * plain recursive `rm` fails on them with EACCES and would leave the run's directory behind.
 */
async function removeTree(path: string): Promise<void> {
    const stats = await lstat(path).catch(() => null);
    if (stats === null) return;
    if (stats.isDirectory()) {
        if ((stats.mode & 0o700) !== 0o700) await chmod(path, 0o700);
        for (const entry of await readdir(path)) await removeTree(join(path, entry));
    }
    await rm(path, { recursive: true, force: true });
}

function outputOf(engines: readonly { readonly engine: EngineProcess; readonly label: string }[]): string | undefined {
    if (engines.length === 0) return undefined;
    return engines
        .map(({ engine, label }, index) => {
            const exits = engine.exits.map((exit) => exit.signal ?? String(exit.code)).join(', ');
            const logs = engine.logs();
            const tail = logs.length > OUTPUT_TAIL_CHARS ? `…${logs.slice(-OUTPUT_TAIL_CHARS)}` : logs;
            return `--- engine ${String(index + 1)}${label}: ${String(engine.starts)} starts, exits: ${exits || 'none'} ---\n${tail}`;
        })
        .join('\n');
}

async function bounded(task: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        task.catch(() => undefined),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, TEARDOWN_TIMEOUT_MS);
        }),
    ]);
    clearTimeout(timer);
}
