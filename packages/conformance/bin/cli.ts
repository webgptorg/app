import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { CheckResult, ConformanceTarget, SessionCredential } from '../src/index';
import {
    ALL_SUITES,
    createMockEngineTarget,
    runConformance,
    summarize,
    writeJsonReport,
    writeJunitReport,
} from '../src/index';

export const USAGE = `Usage: ptbk-conformance --base-url <https://engine> [options]

Credentials (one of):
  --target-module <file>      A module exporting createConformanceTarget({ baseUrl, fetch }) → ConformanceTarget
  --mock-control-url <url>    The mock engine's control listener (development only)
  PTBK_CONFORMANCE_OWNER_COOKIE=<name=value>
                              An owner session cookie; checks that need members then skip

Options:
  --suite <id>                Run only this suite (repeatable): ${ALL_SUITES.map(({ id }) => id).join(', ')}
  --filter <text>             Run only checks whose ID contains this text (repeatable)
  --report json|junit         Report format (default json)
  --out <file>                Write the report here instead of stdout
  --engine-public-key <key>   The engine's Ed25519 public key (base64url), to check its engine ID
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

async function run(argv: readonly string[], io: CliIo): Promise<number> {
    const { values } = parseArgs({
        args: [...argv],
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
            help: { type: 'boolean', default: false },
        },
    }) as { values: Record<string, string | string[] | boolean | undefined> };
    if (values['help'] === true) {
        io.stdout(`${USAGE}\n`);
        return 0;
    }
    const baseUrl = parseUrl(values['base-url'], '--base-url');
    const report = values['report'];
    if (report !== 'json' && report !== 'junit') throw new UsageError('--report must be json or junit');
    const seed = values['seed'] === undefined ? undefined : integer(values['seed'], '--seed', 2 ** 32 - 1);
    const timeoutMs = integer(values['timeout-ms'], '--timeout-ms', 3_600_000);
    const suiteIds = (values['suite'] as string[] | undefined) ?? ALL_SUITES.map(({ id }) => id);
    const suites = suiteIds.map((id) => {
        const suite = ALL_SUITES.find((candidate) => candidate.id === id);
        if (suite === undefined) throw new UsageError(`unknown suite ${id}`);
        return suite;
    });
    const filters = (values['filter'] as string[] | undefined) ?? [];

    const target = await targetFrom(values, baseUrl, io);
    const result = await runConformance({
        target,
        suites,
        timeoutMs,
        signal: io.signal,
        ...(seed === undefined ? {} : { seed }),
        ...(filters.length === 0 ? {} : { filter: (check) => filters.some((text) => check.id.includes(text)) }),
        onResult: (check) => {
            io.stderr(progressLine(check));
        },
    });
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
