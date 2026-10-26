import { RELEASE_DELAYS } from '@ptbk/protocol';

import type { CheckContext } from '../../../check';
import { Findings } from '../../../check';
import type { Bench, Observation } from '../bench';
import { describeCheck, sleep } from '../bench';
import type { UiLoaderCheck } from './common';
import { expectStillActive } from './common';

const HOUR_MS = 3_600_000;
/** `eligibleAt` and `at` have second precision; the engine computes `firstSeenAt` a moment after the start. */
const SLACK_MS = 2_000;

interface Delayed {
    readonly label: string;
    readonly publishedAt: Date;
    readonly integratedTime: Date;
}

/** Publishes a newer valid release, names it in `latest.json` and restarts under `auto`. */
async function underAuto(
    bench: Bench,
    ctx: CheckContext,
    delayed: Delayed,
): Promise<Observation & { version: string }> {
    await bench.baseline(ctx);
    await bench.revocations();
    const published = await bench.publish(bench.nextVersion(), {
        release: {
            entry: { publishedAt: delayed.publishedAt },
            provenance: { integratedTime: delayed.integratedTime },
        },
    });
    bench.setLatest(published.version);
    return { ...(await bench.auto(ctx)), version: published.version };
}

function eligibleAtOf(findings: Findings, label: string, seen: Observation & { version: string }): number | null {
    const { check } = seen;
    if (check.outcome !== 'refused' || check.reason !== 'delay-not-elapsed' || check.version !== seen.version) {
        findings.add(`${label}: expected refused ${seen.version} delay-not-elapsed, got ${describeCheck(check)}`);
        return null;
    }
    if (check.eligibleAt === null) {
        findings.add(`${label}: lastUpdateCheck.eligibleAt is missing (engine API 1.10.0)`);
        return null;
    }
    return Date.parse(check.eligibleAt);
}

export const delayTrustedTime: UiLoaderCheck = {
    id: 'ui-loader.delay.trusted-time',
    title: 'Under auto, the delay counts from the latest of publishedAt, the verified trusted time and first sight',
    async run(bench, ctx) {
        const findings = new Findings();
        const now = Date.now();
        for (const delayed of [
            {
                label: 'publishedAt backdated by 100 h',
                publishedAt: new Date(now - 100 * HOUR_MS),
                integratedTime: new Date(now - 60_000),
                earliest: now,
            },
            {
                label: 'trusted time an hour ahead',
                publishedAt: new Date(now),
                integratedTime: new Date(now + HOUR_MS),
                earliest: now + HOUR_MS,
            },
            {
                label: 'publishedAt two hours ahead',
                publishedAt: new Date(now + 2 * HOUR_MS),
                integratedTime: new Date(now),
                earliest: now + 2 * HOUR_MS,
            },
        ]) {
            const baseline = await bench.baseline(ctx);
            const seen = await underAuto(bench, ctx, delayed);
            const eligibleAt = eligibleAtOf(findings, delayed.label, seen);
            const expected = delayed.earliest + RELEASE_DELAYS.regularMs - SLACK_MS;
            if (eligibleAt !== null && eligibleAt < expected) {
                findings.add(
                    `${delayed.label}: eligible at ${new Date(eligibleAt).toISOString()}, before ${new Date(expected).toISOString()}`,
                );
            }
            await expectStillActive(bench, ctx, findings, delayed.label, baseline, seen);
        }
        return findings.outcome();
    },
};

export const firstSeenPersisted: UiLoaderCheck = {
    id: 'ui-loader.delay.first-seen-persisted',
    title: 'The first time a release was seen survives a restart, so restarting does not reset the delay',
    async run(bench, ctx) {
        const findings = new Findings();
        const old = new Date(Date.now() - 100 * HOUR_MS);
        const startedAt = Date.now();
        const first = await underAuto(bench, ctx, { label: 'first sight', publishedAt: old, integratedTime: old });
        const before = eligibleAtOf(findings, 'first sight', first);
        if (before !== null && before < startedAt + RELEASE_DELAYS.regularMs - SLACK_MS) {
            findings.add(
                `first sight: eligible at ${new Date(before).toISOString()}, less than 72 h after first sight`,
            );
        }
        // Long enough that a first-seen time taken again on restart lands in a later second.
        await sleep(2_100, ctx.signal);
        const again = { ...(await bench.auto(ctx)), version: first.version };
        const after = eligibleAtOf(findings, 'after a restart', again);
        if (before !== null && after !== null && after !== before) {
            findings.add(
                `after a restart: eligible at ${new Date(after).toISOString()} instead of ${new Date(before).toISOString()}`,
            );
        }
        return findings.outcome();
    },
};
