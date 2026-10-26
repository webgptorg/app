import type { Random } from '@ptbk/protocol';

import type { ConformanceTarget } from './target';

export type CheckOutcome =
    | { readonly kind: 'pass' }
    | { readonly kind: 'fail'; readonly detail: string }
    | { readonly kind: 'skip'; readonly reason: string };

/** Undoes what a check created; runs after the check, in reverse order, whatever its outcome. */
export interface ResourceTracker {
    defer(cleanup: (signal: AbortSignal) => Promise<unknown>): void;
}

/** What every check gets, whatever it tests: engine API checks add the target, platform checks the harness. */
export interface BaseCheckContext {
    /** Seeded per run, so the names and values a failing run used can be reproduced. */
    readonly random: Random;
    /** Aborts when the check times out or the run is cancelled. */
    readonly signal: AbortSignal;
    readonly resources: ResourceTracker;
    /** Every resource a check creates is named `conformance-<runId>-…`, so leftovers are easy to find. */
    readonly runId: string;
}

export interface CheckContext extends BaseCheckContext {
    readonly target: ConformanceTarget;
}

/**
 * One conformance requirement. `id` is stable: engine teams track results by it, so renaming one is a breaking change.
 * Every ID is declared as an `id: '<suite>.<group>.<name>'` literal; the engine integration guide's checklist is
 * checked against those literals.
 */
export interface ConformanceCheck<Context extends BaseCheckContext = CheckContext> {
    readonly id: string;
    readonly suite: string;
    readonly title: string;
    run(ctx: Context): Promise<CheckOutcome>;
}

export interface ConformanceSuite<Context extends BaseCheckContext = CheckContext> {
    readonly id: string;
    readonly checks: readonly ConformanceCheck<Context>[];
    /** What the report names as the engine's version, if the suite can find out. */
    engineVersion?(ctx: Context): Promise<string | null>;
}

/** Thrown inside a check to fail it; the runner turns it into a `fail` outcome. */
export class CheckFailure extends Error {
    override readonly name = 'CheckFailure';
}

/** Thrown inside a check when the target cannot support it; the runner turns it into a `skip` outcome. */
export class CheckSkip extends Error {
    override readonly name = 'CheckSkip';
}

export function fail(detail: string): never {
    throw new CheckFailure(detail);
}

export function skip(reason: string): never {
    throw new CheckSkip(reason);
}

export const PASS: CheckOutcome = Object.freeze({ kind: 'pass' });

/** Collects every violation instead of stopping at the first, so one run shows the whole picture. */
export class Findings {
    readonly #items: string[] = [];

    add(finding: string): void {
        this.#items.push(finding);
    }

    get count(): number {
        return this.#items.length;
    }

    outcome(): CheckOutcome {
        if (this.#items.length === 0) return PASS;
        const shown = this.#items.slice(0, MAX_FINDINGS_SHOWN);
        const more = this.#items.length - shown.length;
        return { kind: 'fail', detail: [...shown, ...(more > 0 ? [`… and ${String(more)} more`] : [])].join('\n') };
    }
}

const MAX_FINDINGS_SHOWN = 20;

/** For the later suites whose IDs are registered now, so engine teams can track them (ADR 0014). */
export function notImplemented(check: Omit<ConformanceCheck, 'run'>): ConformanceCheck {
    return { ...check, run: () => Promise.resolve({ kind: 'skip', reason: 'not-implemented' }) };
}
