import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hostname } from '@ptbk/protocol';
import { Hostname as HostnameSchema } from '@ptbk/protocol';

import type { CheckOutcome, CheckResult, ConformanceReport } from '../../src/index';
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
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_START_TIMEOUT_MS } from './platform';

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
 * down when the check ends, whatever its outcome. One ephemeral CA serves the whole run.
 */
export async function runPlatformConformance(options: RunPlatformOptions): Promise<ConformanceReport> {
    const expectations: PlatformExpectations = {
        heartbeatIntervalMs: options.expectations?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        startTimeoutMs: options.expectations?.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    };
    const runDir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'ptbk-conformance-'));
    await chmod(runDir, 0o700);
    const ca = createTestCa('ptbk-conformance test CA', { permittedDomains: [LOOPBACK_DOMAIN] });
    const caFile = join(runDir, 'test-ca.pem');
    await writeFile(caFile, ca.certPem, { mode: 0o600 });
    let checkIndex = 0;
    let dirIndex = 0;

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
            scope: (base) => {
                const checkDir = join(runDir, `check-${String(++checkIndex)}`);
                const engines: EngineProcess[] = [];
                const fixtures: Closable[] = [];
                const tempDir = async (label: string): Promise<string> => {
                    await mkdir(checkDir, { recursive: true, mode: 0o700 });
                    const dir = join(checkDir, `${String(++dirIndex)}-${label.replace(/[^a-z0-9-]/gi, '_')}`);
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
                    engineTarget: (engine, endpoint) => options.targets?.target(engine, endpoint) ?? null,
                    engineCertificateAuthority: (engine) =>
                        options.targets?.certificateAuthority?.(engine) ?? Promise.resolve(null),
                };
                return {
                    context,
                    async finish(outcome: CheckOutcome) {
                        await Promise.all(engines.map((engine) => engine.stop()));
                        const engineOutput = outcome.kind === 'fail' ? outputOf(engines) : undefined;
                        for (const fixture of fixtures.reverse()) await bounded(fixture.close());
                        await rm(checkDir, { recursive: true, force: true });
                        return engineOutput === undefined ? {} : { engineOutput };
                    },
                };
            },
        });
    } finally {
        await rm(runDir, { recursive: true, force: true });
    }
}

function outputOf(engines: readonly EngineProcess[]): string | undefined {
    if (engines.length === 0) return undefined;
    return engines
        .map((engine, index) => {
            const exits = engine.exits.map((exit) => exit.signal ?? String(exit.code)).join(', ');
            const logs = engine.logs();
            const tail = logs.length > OUTPUT_TAIL_CHARS ? `…${logs.slice(-OUTPUT_TAIL_CHARS)}` : logs;
            return `--- engine ${String(index + 1)}: ${String(engine.starts)} starts, exits: ${exits || 'none'} ---\n${tail}`;
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
