import { encodeBase32Lower } from '@ptbk/protocol';
import type { Random } from '@ptbk/protocol';

import { CheckFailure, CheckSkip } from './check';
import type { BaseCheckContext, CheckContext, CheckOutcome, ConformanceCheck, ConformanceSuite } from './check';
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
    /** The engine's own output, only for a failed check the harness started the engine for. */
    readonly engineOutput?: string;
}

export interface ConformanceReport {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly engineVersion: string | null;
    readonly seed: number;
    readonly runId: string;
    readonly results: readonly CheckResult[];
}

interface RunOptions {
    /** Per check, cleanup not included. */
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    /** Defaults to a random one; the report records it, so a run can be repeated with the same data. */
    readonly seed?: number;
    readonly now?: () => Date;
    /** Called after each check, e.g. for progress output. */
    readonly onResult?: (result: CheckResult) => void;
}

export interface RunConformanceOptions extends RunOptions {
    readonly target: ConformanceTarget;
    readonly suites: readonly ConformanceSuite[];
    /** Runs only the checks it accepts. */
    readonly filter?: (check: ConformanceCheck) => boolean;
}

/** A check's own scope: the context it runs with, and what to add to its result once it is over. */
export interface CheckScope<Context extends BaseCheckContext> {
    readonly context: Context;
    /** Runs after the check's cleanup, whatever its outcome; returns the engine output to report on failure. */
    finish(outcome: CheckOutcome): Promise<{ readonly engineOutput?: string }>;
}

export interface RunChecksOptions<Context extends BaseCheckContext> extends RunOptions {
    readonly suites: readonly ConformanceSuite<Context>[];
    readonly filter?: (check: ConformanceCheck<Context>) => boolean;
    /** Builds each check's context from the shared base; the scope ends after the check's cleanup. */
    readonly scope: (base: BaseCheckContext, check: ConformanceCheck<Context> | null) => CheckScope<Context>;
    /** A longer timeout for checks that must wait, e.g. for several heartbeat intervals. */
    readonly timeoutFor?: (check: ConformanceCheck<Context>) => number;
}

const CLEANUP_TIMEOUT_MS = 30_000;

/** Runs every selected engine API check, one at a time, each with its own timeout; cleanup always runs. */
export async function runConformance(options: RunConformanceOptions): Promise<ConformanceReport> {
    return runChecks<CheckContext>({
        ...options,
        scope: (base) => ({ context: { ...base, target: options.target }, finish: () => Promise.resolve({}) }),
    });
}

/**
 * The runner for any kind of check: one at a time, each with its own timeout and context, cleanup always run. The
 * first suite that can name the engine's version does so for the report.
 */
export async function runChecks<Context extends BaseCheckContext>(
    options: RunChecksOptions<Context>,
): Promise<ConformanceReport> {
    const now = options.now ?? (() => new Date());
    const seed = options.seed ?? randomSeed();
    const random = createSeededRandom(seed);
    const runId = encodeBase32Lower(random.bytes(5));
    const startedAt = now().toISOString();
    const base = { random, runId };

    let engineVersion: string | null = null;
    for (const suite of options.suites) {
        if (engineVersion !== null || suite.engineVersion === undefined) continue;
        const describe = suite.engineVersion.bind(suite);
        const probe = await runBounded(options.timeoutMs, options, base, null, (ctx: Context) =>
            describe(ctx).catch(() => null),
        );
        await probe.finish({ kind: 'pass' });
        engineVersion = probe.value ?? null;
    }

    const results: CheckResult[] = [];
    for (const suite of options.suites) {
        for (const check of suite.checks) {
            if (options.filter && !options.filter(check)) continue;
            options.signal.throwIfAborted();
            const started = now().getTime();
            const timeoutMs = Math.max(options.timeoutMs, options.timeoutFor?.(check) ?? 0);
            const run = await runBounded(timeoutMs, options, base, check, (ctx: Context) => check.run(ctx));
            const outcome: CheckOutcome = run.timedOut
                ? { kind: 'fail', detail: `timed out after ${String(timeoutMs)} ms` }
                : run.error === undefined
                  ? (run.value ?? { kind: 'fail', detail: 'check returned no outcome' })
                  : outcomeOf(run.error);
            const finished = await run.finish(outcome);
            const result: CheckResult = {
                id: check.id,
                suite: check.suite,
                title: check.title,
                outcome,
                durationMs: now().getTime() - started,
                cleanupFailures: run.cleanupFailures,
                ...(outcome.kind === 'fail' && finished.engineOutput !== undefined
                    ? { engineOutput: finished.engineOutput }
                    : {}),
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
    readonly finish: (outcome: CheckOutcome) => Promise<{ readonly engineOutput?: string }>;
}

/**
 * Races the body against its timeout, so a check that ignores its signal cannot stall the run, then runs the cleanup
 * it registered, newest first, with a fresh timeout of its own.
 */
async function runBounded<T, Context extends BaseCheckContext>(
    timeoutMs: number,
    options: RunChecksOptions<Context>,
    base: { readonly random: Random; readonly runId: string },
    check: ConformanceCheck<Context> | null,
    body: (ctx: Context) => Promise<T>,
): Promise<BoundedRun<T>> {
    const timeout = new AbortController();
    const signal = AbortSignal.any([options.signal, timeout.signal]);
    const cleanups: ((signal: AbortSignal) => Promise<unknown>)[] = [];
    const scope = options.scope({ ...base, signal, resources: { defer: (cleanup) => cleanups.push(cleanup) } }, check);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
            timeout.abort(new DOMException('check timed out', 'TimeoutError'));
            resolve('timeout');
        }, timeoutMs);
    });
    let run: Omit<BoundedRun<T>, 'cleanupFailures' | 'finish'>;
    try {
        const settled = await Promise.race([
            // A check that throws before its first await is still a promise rejection, not a crash of the run.
            Promise.resolve()
                .then(() => body(scope.context))
                .then(
                    (value) => ({ value }),
                    (error: unknown) => ({ error }),
                ),
            expired,
        ]);
        run =
            settled === 'timeout'
                ? { timedOut: true }
                : 'error' in settled
                  ? { error: settled.error, timedOut: false }
                  : { value: settled.value, timedOut: false };
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
    return { ...run, cleanupFailures, finish: (outcome) => scope.finish(outcome) };
}

function outcomeOf(error: unknown): CheckOutcome {
    if (error instanceof CheckFailure) return { kind: 'fail', detail: error.message };
    if (error instanceof CheckSkip) return { kind: 'skip', reason: error.message };
    // Only the error's kind and message: they come from fetch, timers or our own code, never from response bodies.
    if (error instanceof Error) return { kind: 'fail', detail: `unexpected ${error.name}: ${error.message}` };
    return { kind: 'fail', detail: 'unexpected error' };
}
