import { describe, expect, it } from 'vitest';

import { createMonitoringTestDeps } from '../../testing/test-monitoring';
import { createManualTimer } from '../../testing/manual-timer';
import type { Alert } from '../monitoring/alert-rules';
import type { DispatcherDeps, ScheduledJob } from './scheduled-dispatcher';
import { createScheduledDispatcher } from './scheduled-dispatcher';

const EVERY_MINUTE = '* * * * *';
const alert: Alert = { rule: 'cron-job-failing', subject: 'broken', state: 'firing', at: 0, detail: {} };

function setup(jobs: readonly ScheduledJob[], overrides: Partial<DispatcherDeps> = {}) {
    const { clock, logger, metrics } = createMonitoringTestDeps(1000);
    const timer = createManualTimer();
    const runs: { job: string; outcome: string }[] = [];
    const delivered: Alert[][] = [];
    const dispatcher = createScheduledDispatcher({
        jobs,
        clock,
        timer,
        logger,
        metrics,
        recordRun: (run) => {
            runs.push({ job: run.job, outcome: run.outcome });
            return Promise.resolve(run.outcome === 'failed' ? [alert] : []);
        },
        deliver: (alerts) => {
            delivered.push([...alerts]);
            return Promise.resolve();
        },
        jobTimeoutMs: 50_000,
        ...overrides,
    });
    return { dispatcher, clock, timer, logger, metrics, runs, delivered };
}

const job = (name: string, run: ScheduledJob['run'], cron = EVERY_MINUTE): ScheduledJob => ({ name, cron, run });

describe('createScheduledDispatcher', () => {
    it('runs every job of the cron that fired, isolates a failing one, and records each run', async () => {
        const seen: number[] = [];
        const { dispatcher, runs, delivered, metrics, logger } = setup([
            job('ok-job', ({ scheduledTime }) => {
                seen.push(scheduledTime);
                return Promise.resolve();
            }),
            job('broken', () => Promise.reject(new TypeError('boom'))),
            job('throws', () => {
                throw new RangeError('sync');
            }),
            job('hourly', () => Promise.reject(new Error('must not run')), '0 * * * *'),
        ]);
        const results = await dispatcher.dispatch(EVERY_MINUTE, 42);
        expect(results.map((result) => [result.job, result.outcome])).toEqual([
            ['ok-job', 'ok'],
            ['broken', 'failed'],
            ['throws', 'failed'],
        ]);
        expect(seen).toEqual([42]);
        // Side by side: in whatever order they finish.
        expect(runs).toHaveLength(3);
        expect(runs).toEqual(
            expect.arrayContaining([
                { job: 'ok-job', outcome: 'ok' },
                { job: 'broken', outcome: 'failed' },
                { job: 'throws', outcome: 'failed' },
            ]),
        );
        expect(delivered.flat()).toEqual([alert, alert]);
        expect(metrics.records.map((record) => record.metric)).toContainEqual({
            name: 'ptbk_dashboard_cron_runs_total',
            job: 'broken',
            outcome: 'failed',
            durationMs: 0,
        });
        expect(logger.entries).toContainEqual({
            level: 'error',
            event: 'cron.job-failed',
            fields: { job: 'broken', problem: 'TypeError' },
        });
    });

    it('fails a job that outlives its time and aborts its signal', async () => {
        let aborted = false;
        const { dispatcher, timer, logger } = setup([
            job(
                'slow',
                ({ signal }) =>
                    new Promise((_, reject) => {
                        signal.addEventListener('abort', () => {
                            aborted = true;
                            reject(new Error('aborted'));
                        });
                    }),
            ),
        ]);
        const dispatched = dispatcher.dispatch(EVERY_MINUTE, 0);
        await Promise.resolve();
        timer.elapse();
        const [result] = await dispatched;
        expect(result?.outcome).toBe('failed');
        expect(aborted).toBe(true);
        expect(logger.entries).toContainEqual({
            level: 'error',
            event: 'cron.job-failed',
            fields: { job: 'slow', problem: 'timeout' },
        });
    });

    it('logs a cron no job is registered for, and a run it cannot record', async () => {
        const { dispatcher, logger } = setup([job('ok-job', () => Promise.resolve())], {
            recordRun: () => Promise.reject(new Error('object down')),
        });
        await expect(dispatcher.dispatch('0 0 * * *', 0)).resolves.toEqual([]);
        await dispatcher.dispatch(EVERY_MINUTE, 0);
        expect(logger.entries.map((entry) => entry.event)).toEqual(['cron.no-jobs', 'cron.record-failed']);
        const { dispatcher: other, logger: otherLogger } = setup([
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- jobs may reject with anything
            job('x', () => Promise.reject('a string')),
        ]);
        await other.dispatch(EVERY_MINUTE, 0);
        expect(otherLogger.entries[0]?.fields).toEqual({ job: 'x', problem: 'unknown' });
    });

    it('refuses duplicate or malformed job names', () => {
        const noop = () => Promise.resolve();
        expect(() => setup([job('a', noop), job('a', noop)])).toThrow('unique');
        expect(() => setup([job('Not Dashed', noop)])).toThrow('unique');
    });
});
