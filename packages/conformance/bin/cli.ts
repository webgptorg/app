import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    ENGINE_API_PLATFORM_SUITE,
    PLATFORM_SUITES,
    createEngineApiPlatformSuite,
    createMockEngineTargetFactory,
    createSessionCommandTargetFactory,
    runPlatformConformance,
} from '../node/index';
import type { CheckResult, ConformanceReport, ConformanceTarget, SessionCredential } from '../src/index';
import {
    ALL_SUITES,
    createMockEngineTarget,
    runConformance,
    summarize,
    writeJsonReport,
    writeJunitReport,
} from '../src/index';

export const USAGE = `Usage: ptbk-conformance --base-url <https://engine> [options]
       ptbk-conformance --engine-cmd <shell command> [options]

Credentials against --base-url (one of):
  --target-module <file>      A module exporting createConformanceTarget({ baseUrl, fetch }) → ConformanceTarget
  --mock-control-url <url>    The mock engine's control listener (development only)
  PTBK_CONFORMANCE_OWNER_COOKIE=<name=value>
                              An owner session cookie; checks that need members then skip
  --engine-public-key <key>   The engine's Ed25519 public key (base64url), to check its engine ID

Starting the engine (the harness plays the dashboard, the relays and the release store):
  --engine-cmd <command>      Starts the engine under test (run by /bin/sh): one engine for the engine-api suite,
                              one or more per check of the other suites
  --engine-cwd <dir>          Its working directory (default: the current one)
  --heartbeat-interval-s <n>  The interval the engine was told to use (default 60; anything else skips the cadence check)
  --engine-session-cmd <cmd>  The engine's conformance-session command, run with --subject owner|member
                              [--permissions a,b]; it prints {"cookie"}, {"bearer"} or null as JSON. Without it
                              or --mock-control, the engine API checks that need a session skip
  --engine-ca-file <file>     The CA the engine's own certificates chain to under test ({dataDir} for its data
                              directory); with --engine-session-cmd
  --mock-control              The engine is the mock engine: sessions from its dev-only control listener

Options:
  --suite <id>                Run only these suites (repeatable or comma-separated)
                              against --base-url: ${ALL_SUITES.map(({ id }) => id).join(', ')}
                              with --engine-cmd: ${PLATFORM_SUITES.map(({ id }) => id).join(', ')}
  --filter <text>             Run only checks whose ID contains this text (repeatable)
  --report json|junit         Report format (default json)
  --out <file>                Write the report here instead of stdout
  --no-gateway                The API runs without the engine gateway; gateway checks skip
  --seed <n>                  Repeat a run's test data (the report records the seed)
  --timeout-ms <n>            Per check (default 120000)

Exit code 0 only when no check failed; 1 when one did; 2 for a usage error.`;

export interface CliIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly fetch: typeof fetch;
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
    readonly signal: AbortSignal;
}

class UsageError extends Error {}

/** Parses arguments, runs the suites and writes the report; resolves with the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
    try {
        return await run(argv, io);
    } catch (error) {
        if (error instanceof UsageError) {
            io.stderr(`${error.message}\n\n${USAGE}\n`);
            return 2;
        }
        throw error;
    }
}

const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;

/** parseArgs takes a value starting with "-" for an option, and one in 64 base64url keys starts with one. */
function withInlineKey(argv: readonly string[]): string[] {
    const args = [...argv];
    const at = args.indexOf('--engine-public-key');
    const key = at < 0 ? undefined : args[at + 1];
    if (key !== undefined && BASE64URL_KEY.test(key)) args.splice(at, 2, `--engine-public-key=${key}`);
    return args;
}

async function run(argv: readonly string[], io: CliIo): Promise<number> {
    const { values } = parseArgs({
        args: withInlineKey(argv),
        strict: true,
        allowPositionals: false,
        options: {
            'base-url': { type: 'string' },
            suite: { type: 'string', multiple: true },
            filter: { type: 'string', multiple: true },
            report: { type: 'string', default: 'json' },
            out: { type: 'string' },
            'target-module': { type: 'string' },
            'mock-control-url': { type: 'string' },
            'engine-public-key': { type: 'string' },
            'no-gateway': { type: 'boolean', default: false },
            seed: { type: 'string' },
            'timeout-ms': { type: 'string', default: '120000' },
            'engine-cmd': { type: 'string' },
            'engine-cwd': { type: 'string' },
            'heartbeat-interval-s': { type: 'string' },
            'mock-control': { type: 'boolean', default: false },
            'engine-session-cmd': { type: 'string' },
            'engine-ca-file': { type: 'string' },
            help: { type: 'boolean', default: false },
        },
    }) as { values: Record<string, string | string[] | boolean | undefined> };
    if (values['help'] === true) {
        io.stdout(`${USAGE}\n`);
        return 0;
    }
    const report = values['report'];
    if (report !== 'json' && report !== 'junit') throw new UsageError('--report must be json or junit');
    const seed = values['seed'] === undefined ? undefined : integer(values['seed'], '--seed', 2 ** 32 - 1);
    const timeoutMs = integer(values['timeout-ms'], '--timeout-ms', 3_600_000);
    const suiteIds = ((values['suite'] as string[] | undefined) ?? []).flatMap((list) =>
        list.split(',').map((id) => id.trim()),
    );
    const filters = (values['filter'] as string[] | undefined) ?? [];
    const filter =
        filters.length === 0
            ? {}
            : { filter: (check: { id: string }) => filters.some((text) => check.id.includes(text)) };
    const common = {
        timeoutMs,
        signal: io.signal,
        ...(seed === undefined ? {} : { seed }),
        ...filter,
        onResult: (check: CheckResult) => {
            io.stderr(progressLine(check));
        },
    };

    let result: ConformanceReport;
    const engineCmd = values['engine-cmd'];
    if (typeof engineCmd === 'string') {
        if (values['base-url'] !== undefined) throw new UsageError('give either --base-url or --engine-cmd');
        for (const flag of ['target-module', 'mock-control-url', 'engine-public-key'] as const) {
            if (values[flag] !== undefined) {
                throw new UsageError(
                    `--${flag} is for --base-url; with --engine-cmd the harness knows the engine's key and gets sessions from --engine-session-cmd or --mock-control`,
                );
            }
        }
        const engineApi = values['no-gateway'] === true ? createEngineApiPlatformSuite({ gateway: false }) : null;
        const available = PLATFORM_SUITES.map((suite) =>
            engineApi !== null && suite === ENGINE_API_PLATFORM_SUITE ? engineApi : suite,
        );
        const suites = pick(suiteIds, available, (id) => `unknown suite ${id}`);
        const intervalS =
            values['heartbeat-interval-s'] === undefined
                ? DEFAULT_HEARTBEAT_INTERVAL_MS / 1000
                : integer(values['heartbeat-interval-s'], '--heartbeat-interval-s', 3600);
        if (intervalS === 0) throw new UsageError('--heartbeat-interval-s must be at least 1');
        const cwd = values['engine-cwd'];
        const engineCwd = resolve(typeof cwd === 'string' ? cwd : '.');
        const sessionCmd = values['engine-session-cmd'];
        if (typeof sessionCmd === 'string' && values['mock-control'] === true) {
            throw new UsageError('give either --engine-session-cmd or --mock-control');
        }
        if (values['engine-ca-file'] !== undefined && typeof sessionCmd !== 'string') {
            throw new UsageError('--engine-ca-file needs --engine-session-cmd');
        }
        const targets =
            typeof sessionCmd === 'string'
                ? createSessionCommandTargetFactory(
                      { command: sessionCmd, cwd: engineCwd },
                      typeof values['engine-ca-file'] === 'string' ? { caFile: values['engine-ca-file'] } : {},
                  )
                : values['mock-control'] === true
                  ? createMockEngineTargetFactory()
                  : undefined;
        result = await runPlatformConformance({
            ...common,
            command: { command: engineCmd, cwd: engineCwd },
            suites,
            expectations: { heartbeatIntervalMs: intervalS * 1000 },
            ...(targets === undefined ? {} : { targets }),
            parentEnv: io.env,
        });
    } else {
        for (const flag of ['engine-cwd', 'heartbeat-interval-s'] as const) {
            if (values[flag] !== undefined) throw new UsageError(`--${flag} needs --engine-cmd`);
        }
        if (values['mock-control'] === true) throw new UsageError('--mock-control needs --engine-cmd');
        if (values['engine-session-cmd'] !== undefined) throw new UsageError('--engine-session-cmd needs --engine-cmd');
        const baseUrl = parseUrl(values['base-url'], '--base-url');
        const suites = pick(suiteIds, ALL_SUITES, (id) =>
            PLATFORM_SUITES.some((suite) => suite.id === id)
                ? `${id} starts the engine itself: give --engine-cmd instead of --base-url`
                : `unknown suite ${id}`,
        );
        const target = await targetFrom(values, baseUrl, io);
        result = await runConformance({ ...common, target, suites });
    }
    const text = report === 'json' ? writeJsonReport(result) : writeJunitReport(result);
    const out = values['out'];
    if (typeof out === 'string') await writeFile(out, text);
    else io.stdout(text);
    const summary = summarize(result);
    io.stderr(
        `${String(summary.passed)} passed, ${String(summary.failed)} failed, ${String(summary.skipped)} skipped (seed ${String(result.seed)})\n`,
    );
    return summary.failed === 0 ? 0 : 1;
}

async function targetFrom(
    values: Record<string, string | string[] | boolean | undefined>,
    baseUrl: URL,
    io: CliIo,
): Promise<ConformanceTarget> {
    const extras: { enginePublicKey?: string; gateway?: boolean } = {};
    if (typeof values['engine-public-key'] === 'string') extras.enginePublicKey = values['engine-public-key'];
    if (values['no-gateway'] === true) extras.gateway = false;

    const modulePath = values['target-module'];
    const controlUrl = values['mock-control-url'];
    const ownerCookie = io.env['PTBK_CONFORMANCE_OWNER_COOKIE'];
    const given = [modulePath, controlUrl, ownerCookie].filter((value) => value !== undefined && value !== '');
    if (given.length > 1) {
        throw new UsageError('give one of --target-module, --mock-control-url and PTBK_CONFORMANCE_OWNER_COOKIE');
    }
    if (typeof modulePath === 'string') {
        // Loading the engine team's own target is the point of this option; it runs with the CLI's privileges.
        const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
            readonly createConformanceTarget?: (options: { baseUrl: URL; fetch: typeof fetch }) => unknown;
        };
        if (typeof loaded.createConformanceTarget !== 'function') {
            throw new UsageError(`${modulePath} does not export createConformanceTarget`);
        }
        const target = (await loaded.createConformanceTarget({ baseUrl, fetch: io.fetch })) as ConformanceTarget;
        return { ...target, ...extras };
    }
    if (typeof controlUrl === 'string') {
        return {
            ...createMockEngineTarget({
                baseUrl,
                controlUrl: parseUrl(controlUrl, '--mock-control-url'),
                fetch: io.fetch,
            }),
            ...extras,
        };
    }
    const owner: SessionCredential | null =
        ownerCookie === undefined || ownerCookie === '' ? null : { cookie: ownerCookie };
    return {
        baseUrl,
        fetch: io.fetch,
        session: (subject) => Promise.resolve(subject.kind === 'owner' ? owner : null),
        ...extras,
    };
}

/** The suites named, in the order given, or every one of `available` when none is. */
function pick<Suite extends { readonly id: string }>(
    ids: readonly string[],
    available: readonly Suite[],
    problem: (id: string) => string,
): Suite[] {
    if (ids.length === 0) return [...available];
    return ids.map((id) => {
        const suite = available.find((candidate) => candidate.id === id);
        if (suite === undefined) throw new UsageError(problem(id));
        return suite;
    });
}

function progressLine(check: CheckResult): string {
    const seconds = `${(check.durationMs / 1000).toFixed(1)}s`;
    const cleanup = check.cleanupFailures > 0 ? ` (${String(check.cleanupFailures)} cleanup steps failed)` : '';
    switch (check.outcome.kind) {
        case 'pass':
            return `pass  ${check.id} ${seconds}${cleanup}\n`;
        case 'skip':
            return `skip  ${check.id}: ${check.outcome.reason}\n`;
        case 'fail':
            return `FAIL  ${check.id} ${seconds}${cleanup}\n${check.outcome.detail.replace(/^/gm, '      ')}\n`;
    }
}

function parseUrl(value: unknown, flag: string): URL {
    if (typeof value !== 'string') throw new UsageError(`${flag} is required`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new UsageError(`${flag} is not a URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`${flag} must be http or https`);
    return url;
}

function integer(value: unknown, flag: string, max: number): number {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed > max)
        throw new UsageError(`${flag} must be an integer up to ${String(max)}`);
    return parsed;
}
