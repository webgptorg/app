import type { UiRefusalReason, UiRevocationReason } from '@ptbk/engine-api';
import type { TrustPolicy } from '@ptbk/protocol';

import type { BaseCheckContext, CheckOutcome, ConformanceCheck } from '../../../check';
import { Findings } from '../../../check';
import type { Bench, Observation, PublishOptions, Published } from '../bench';
import { describeCheck } from '../bench';

export const SUITE = 'ui-loader';

export type BenchProvider = (ctx: BaseCheckContext) => Promise<Bench>;

export interface UiLoaderCheck {
    readonly id: string;
    readonly title: string;
    run(bench: Bench, ctx: BaseCheckContext): Promise<CheckOutcome>;
}

export function toConformanceCheck(check: UiLoaderCheck, bench: BenchProvider | null): ConformanceCheck {
    return {
        id: check.id,
        suite: SUITE,
        title: check.title,
        async run(ctx) {
            if (bench === null) return { kind: 'skip', reason: 'needs-engine-harness' };
            return check.run(await bench(ctx), ctx);
        },
    };
}

export interface RefusalCase {
    readonly label: string;
    /** Accepted reasons: the first failed check, where engines may legitimately differ in which one fires first. */
    readonly reasons: readonly UiRefusalReason[];
    readonly revocationReason?: UiRevocationReason;
    readonly publish?: PublishOptions;
    /** Publishes the candidate itself, e.g. under a version that is not the next one. */
    readonly prepare?: (bench: Bench, version: string) => Promise<void>;
    readonly policy?: TrustPolicy;
    /** Leaves the revocation list as `prepare` set it, instead of publishing a fresh one. */
    readonly keepRevocations?: boolean;
    /** The version to pin; default a new one. */
    readonly version?: (bench: Bench) => string;
}

/** Whether the engine still serves `expected` and its panel says so, after `observation`. */
export async function expectStillActive(
    bench: Bench,
    ctx: BaseCheckContext,
    findings: Findings,
    label: string,
    expected: Published,
    observation: Observation,
): Promise<void> {
    if (observation.ui.version !== expected.version || observation.ui.bundleSha256 !== expected.bundle.sha256) {
        findings.add(`${label}: the panel shows ${observation.ui.version} active instead of ${expected.version}`);
    }
    const served = await bench.servedVersion(ctx);
    if (served !== expected.version) {
        findings.add(`${label}: the engine serves ${served ?? 'no bundle'} instead of ${expected.version}`);
    }
}

/**
 * Pins a candidate that must be refused, from an installed baseline: the check must report the refusal with one of
 * the reasons, and the baseline must stay active and served.
 */
export async function expectRefusal(
    bench: Bench,
    ctx: BaseCheckContext,
    findings: Findings,
    refusal: RefusalCase,
): Promise<Observation> {
    const baseline = await bench.baseline(ctx);
    const version = refusal.version?.(bench) ?? bench.nextVersion();
    if (refusal.keepRevocations !== true) await bench.revocations();
    const published = refusal.prepare === undefined ? await bench.publish(version, refusal.publish) : null;
    if (refusal.prepare !== undefined) await refusal.prepare(bench, version);
    const seen = await bench.pinned(ctx, version, refusal.policy);
    const { check } = seen;
    const reasonOk = check.reason !== null && refusal.reasons.includes(check.reason);
    const revocationOk = refusal.revocationReason === undefined || check.revocationReason === refusal.revocationReason;
    if (check.outcome !== 'refused' || !reasonOk || !revocationOk || check.version !== version) {
        const wanted = [refusal.reasons.join(' or '), refusal.revocationReason].filter(Boolean).join(' ');
        findings.add(`${refusal.label}: expected refused ${version} ${wanted}, got ${describeCheck(check)}`);
    }
    if (published !== null && seen.ui.version === version) {
        bench.active = published;
        bench.installed.push(published);
        findings.add(`${refusal.label}: ${version} was installed`);
        return seen;
    }
    await expectStillActive(bench, ctx, findings, refusal.label, baseline, seen);
    return seen;
}

export async function refusals(
    bench: Bench,
    ctx: BaseCheckContext,
    cases: readonly RefusalCase[],
): Promise<CheckOutcome> {
    const findings = new Findings();
    for (const refusal of cases) await expectRefusal(bench, ctx, findings, refusal);
    return findings.outcome();
}
