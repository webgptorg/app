import { ENGINE_API_ROUTES } from '@ptbk/engine-api';

import { Findings } from '../../../src/index';
import { createWorld } from '../../../src/suites/engine-api/world';
import type { DashboardAnswer, ReceivedHeartbeat } from '../../fakes/dashboard';
import { problemAnswer, startRegisteredEngine } from '../../fakes/dashboard';
import type { EngineApiEndpoint, PlatformCheck, PlatformExpectations } from '../../harness/platform';
import { startTunnelRelay } from '../../tunnel/tunnel-relay';
import { attemptWait, quietly, startLinkedEngine } from '../support';
import { SUITE } from './beats';

/** heartbeat.md: every 60 s. A beat may come 5 s early or 10 s late (a quarter and a half of shorter intervals). */
export function cadenceBounds(expectations: PlatformExpectations): {
    readonly earliest: number;
    readonly latest: number;
} {
    const interval = expectations.heartbeatIntervalMs;
    return { earliest: interval - Math.min(5000, interval / 4), latest: interval + Math.min(10_000, interval / 2) };
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
}

/** Findings for every gap between consecutive beats outside the cadence bounds. */
function gapFindings(
    beats: readonly ReceivedHeartbeat[],
    expectations: PlatformExpectations,
    after: (index: number) => string,
): string[] {
    const { earliest, latest } = cadenceBounds(expectations);
    const findings: string[] = [];
    for (let index = 1; index < beats.length; index++) {
        const gap = (beats[index]?.at ?? 0) - (beats[index - 1]?.at ?? 0);
        if (gap < earliest)
            findings.push(`${after(index)}, the next beat came after ${seconds(gap)}, before the next tick`);
        if (gap > latest) findings.push(`${after(index)}, the next beat came only after ${seconds(gap)}`);
    }
    return findings;
}

function timeoutFor(beats: number) {
    return (expectations: PlatformExpectations): number =>
        expectations.startTimeoutMs * 2 + beats * cadenceBounds(expectations).latest;
}

export const cadenceInterval: PlatformCheck = {
    id: 'heartbeat.cadence.interval',
    suite: SUITE,
    title: 'Heartbeats come every 60 s, and a beat the dashboard answered 503 is not retried before the next tick',
    timeoutMs: timeoutFor(3),
    async run(ctx) {
        if (ctx.expectations.intervalOverridden) {
            return { kind: 'skip', reason: 'interval-overridden: run at the default 60 s to check the cadence' };
        }
        let received = 0;
        const linked = await startLinkedEngine(ctx, {
            onHeartbeat: () => (received++ === 0 ? problemAnswer(503, 'unavailable') : undefined),
        });
        const beats = await attemptWait(
            ctx,
            linked,
            'send three heartbeats',
            () => (linked.dashboard.heartbeats.length >= 3 ? linked.dashboard.heartbeats.slice(0, 3) : undefined),
            timeoutFor(3)(ctx.expectations),
        );
        if (!beats.ok) return { kind: 'fail', detail: beats.reason };
        const findings = new Findings();
        for (const finding of gapFindings(beats.value, ctx.expectations, (index) =>
            index === 1 ? 'after a 503' : `after beat ${String(index)}`,
        )) {
            findings.add(finding);
        }
        return findings.outcome();
    },
};

/** What the dashboard answers to the beats in order; heartbeat.md: log these and keep sending on the interval. */
const ERROR_LABELS = [
    '429 rate-limited',
    '403 engine-suspended',
    '404 not-found',
    '401 bad-signature',
    '401 stale-timestamp',
];
const ERROR_ANSWERS: readonly ((now: Date) => DashboardAnswer)[] = [
    () => problemAnswer(429, 'rate-limited'),
    () => problemAnswer(403, 'engine-suspended'),
    () => problemAnswer(404, 'not-found'),
    () => problemAnswer(401, 'bad-signature'),
    (now) => problemAnswer(401, 'stale-timestamp', { serverTime: now.toISOString().replace(/\.\d{3}Z$/, 'Z') }),
];

export const errorsKeepSending: PlatformCheck = {
    id: 'heartbeat.errors.keeps-sending',
    suite: SUITE,
    title: 'After 429, 403 engine-suspended, 404, 401 bad-signature and 401 stale-timestamp the engine keeps beating on the interval',
    timeoutMs: timeoutFor(ERROR_ANSWERS.length + 1),
    async run(ctx) {
        let received = 0;
        const linked = await startLinkedEngine(ctx, {
            onHeartbeat: (beat) => ERROR_ANSWERS[received++]?.(new Date(beat.at)),
        });
        const count = ERROR_ANSWERS.length + 1;
        const beats = await attemptWait(
            ctx,
            linked,
            `send ${String(count)} heartbeats`,
            () =>
                linked.dashboard.heartbeats.length >= count ? linked.dashboard.heartbeats.slice(0, count) : undefined,
            timeoutFor(count)(ctx.expectations),
        );
        if (!beats.ok) return { kind: 'fail', detail: beats.reason };
        const findings = new Findings();
        const answered = (index: number): string => `after ${ERROR_LABELS[index - 1] ?? 'an accepted beat'}`;
        for (const finding of gapFindings(beats.value, ctx.expectations, answered)) findings.add(finding);
        if (!linked.engine.running) findings.add('the engine exited');
        return findings.outcome();
    },
};

/** How far ahead of the engine the dashboard claims to be, and how close the shown skew must come to it. */
const SKEW_AHEAD_S = 600;
const SKEW_TOLERANCE_S = 15;

export const staleSkewShown: PlatformCheck = {
    id: 'heartbeat.stale-ts.skew-shown',
    suite: SUITE,
    title: "After a stale-timestamp answer, the security panel's clockSkew shows the engine clock minus serverTime",
    timeoutMs: (expectations) => expectations.startTimeoutMs * 3 + expectations.heartbeatIntervalMs * 4,
    async run(ctx) {
        let stale = false;
        const relay = await startTunnelRelay(ctx);
        const registered = await startRegisteredEngine(ctx, {
            env: relay.env,
            dashboard: {
                // From the switch on, every beat is "stale": the dashboard claims to be 10 minutes ahead of it.
                onHeartbeat: (beat) =>
                    stale
                        ? problemAnswer(401, 'stale-timestamp', {
                              serverTime: new Date(beat.at + SKEW_AHEAD_S * 1000)
                                  .toISOString()
                                  .replace(/\.\d{3}Z$/, 'Z'),
                          })
                        : undefined,
            },
        });
        // Whether the run can get sessions at all is known before any tunnel is up; an engine without them skips.
        const unused: EngineApiEndpoint = { baseUrl: new URL('https://unused.invalid'), fetch };
        if (ctx.engineTarget(registered.engine, unused) === null) {
            return {
                kind: 'skip',
                reason: 'engine-api-unreachable: no session source (--engine-session-cmd or --mock-control)',
            };
        }
        const target = ctx.engineTarget(registered.engine, await relay.endpointFor(registered));
        if (target === null) return { kind: 'skip', reason: 'engine-api-unreachable' };
        const world = await createWorld({ ...ctx, target });
        stale = true;
        const answered = await attemptWait(
            ctx,
            registered,
            'send a heartbeat the dashboard answers stale-timestamp',
            () => registered.dashboard.heartbeats.find((beat) => beat.answer.status === 401),
            cadenceBounds(ctx.expectations).latest + ctx.expectations.startTimeoutMs,
        );
        if (!answered.ok) return { kind: 'fail', detail: answered.reason };
        const deadline = Date.now() + cadenceBounds(ctx.expectations).latest;
        const shownSkew = async (): Promise<number | null> =>
            (await world.owner.ok(ENGINE_API_ROUTES.getSecurityOverview)).clockSkew?.seconds ?? null;
        let seconds = await shownSkew();
        while (seconds === null && Date.now() < deadline) {
            await quietly(250, ctx.signal);
            seconds = await shownSkew();
        }
        if (seconds === null)
            return { kind: 'fail', detail: 'the security panel shows no clockSkew after a stale-timestamp answer' };
        if (Math.abs(seconds + SKEW_AHEAD_S) > SKEW_TOLERANCE_S) {
            return {
                kind: 'fail',
                detail: `clockSkew.seconds is ${String(seconds)}; the engine is ${String(SKEW_AHEAD_S)} s behind serverTime, so about -${String(SKEW_AHEAD_S)}`,
            };
        }
        return { kind: 'pass' };
    },
};
