import { encodeBase32Lower } from '@ptbk/protocol';
import type { Random } from '@ptbk/protocol';

import { CheckFailure, CheckSkip } from './check';
import type { CheckContext, CheckOutcome, ConformanceCheck, ConformanceSuite } from './check';
import { createSeededRandom, randomSeed } from './random';
import type { ConformanceTarget } from './target';

export interface CheckResult {
    readonly id: string;
    readonly suite: string;
    readonly title: string;
    readonly outcome: CheckOutcome;
    readonly durationMs: number;
    /** Cleanup that failed after the check; the outcome stands, but something may be left on the engine. */
    readonly cleanupFailures: number;
}

export interface ConformanceReport {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly engineVersion: string | null;
    readonly seed: number;
    readonly runId: string;
    readonly results: readonly CheckResult[];
}

export interface RunConformanceOptions {
    readonly target: ConformanceTarget;
    readonly suites: readonly ConformanceSuite[];
    /** Runs only the checks it accepts. */
    readonly filter?: (check: ConformanceCheck) => boolean;
    /** Per check, cleanup not included. */
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    /** Defaults to a random one; the report records it, so a run can be repeated with the same data. */
    readonly seed?: number;
    readonly now?: () => Date;
    /** Called after each check, e.g. for progress output. */
    readonly onResult?: (result: CheckResult) => void;
}

const CLEANUP_TIMEOUT_MS = 30_000;

/** Runs every selected check, one at a time, each with its own timeout; cleanup always runs. */
export async function runConformance(options: RunConformanceOptions): Promise<ConformanceReport> {
    const now = options.now ?? (() => new Date());
    const seed = options.seed ?? randomSeed();
    const random = createSeededRandom(seed);
    const runId = encodeBase32Lower(random.bytes(5));
    const startedAt = now().toISOString();
    const base = { target: options.target, random, runId };

    let engineVersion: string | null = null;
    for (const suite of options.suites) {
        if (engineVersion !== null || suite.engineVersion === undefined) continue;
        const describe = suite.engineVersion.bind(suite);
        const probe = await runBounded(options, base, (ctx) => describe(ctx).catch(() => null));
        engineVersion = probe.value ?? null;
    }

    const results: CheckResult[] = [];
    for (const suite of options.suites) {
        for (const check of suite.checks) {
            if (options.filter && !options.filter(check)) continue;
            options.signal.throwIfAborted();
            const started = now().getTime();
            const run = await runBounded(options, base, (ctx) => check.run(ctx));
            const outcome: CheckOutcome = run.timedOut
                ? { kind: 'fail', detail: `timed out after ${String(options.timeoutMs)} ms` }
                : run.error === undefined
                  ? (run.value ?? { kind: 'fail', detail: 'check returned no outcome' })
                  : outcomeOf(run.error);
            const result: CheckResult = {
                id: check.id,
                suite: check.suite,
                title: check.title,
                outcome,
                durationMs: now().getTime() - started,
                cleanupFailures: run.cleanupFailures,
            };
            results.push(result);
            options.onResult?.(result);
        }
    }
    return { startedAt, finishedAt: now().toISOString(), engineVersion, seed, runId, results };
}

interface BoundedRun<T> {
    readonly value?: T;
    readonly error?: unknown;
    readonly timedOut: boolean;
    readonly cleanupFailures: number;
}

/**
 * Races the body against its timeout, so a check that ignores its signal cannot stall the run, then runs the cleanup
 * it registered, newest first, with a fresh timeout of its own.
 */
async function runBounded<T>(
    options: RunConformanceOptions,
    base: { readonly target: ConformanceTarget; readonly random: Random; readonly runId: string },
    body: (ctx: CheckContext) => Promise<T>,
): Promise<BoundedRun<T>> {
    const timeout = new AbortController();
    const signal = AbortSignal.any([options.signal, timeout.signal]);
    const cleanups: ((signal: AbortSignal) => Promise<unknown>)[] = [];
    const ctx: CheckContext = { ...base, signal, resources: { defer: (cleanup) => cleanups.push(cleanup) } };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
            timeout.abort(new DOMException('check timed out', 'TimeoutError'));
            resolve('timeout');
        }, options.timeoutMs);
    });
    let run: BoundedRun<T>;
    try {
        const settled = await Promise.race([
            // A check that throws before its first await is still a promise rejection, not a crash of the run.
            Promise.resolve()
                .then(() => body(ctx))
                .then(
                    (value) => ({ value }),
                    (error: unknown) => ({ error }),
                ),
            expired,
        ]);
        run =
            settled === 'timeout'
                ? { timedOut: true, cleanupFailures: 0 }
                : 'error' in settled
                  ? { error: settled.error, timedOut: false, cleanupFailures: 0 }
                  : { value: settled.value, timedOut: false, cleanupFailures: 0 };
    } finally {
        clearTimeout(timer);
    }

    let cleanupFailures = 0;
    for (const cleanup of cleanups.reverse()) {
        try {
            await cleanup(AbortSignal.any([options.signal, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)]));
        } catch {
            cleanupFailures++;
        }
    }
    return { ...run, cleanupFailures };
}

function outcomeOf(error: unknown): CheckOutcome {
    if (error instanceof CheckFailure) return { kind: 'fail', detail: error.message };
    if (error instanceof CheckSkip) return { kind: 'skip', reason: error.message };
    // Only the error's kind and message: they come from fetch, timers or our own code, never from response bodies.
    if (error instanceof Error) return { kind: 'fail', detail: `unexpected ${error.name}: ${error.message}` };
    return { kind: 'fail', detail: 'unexpected error' };
}
