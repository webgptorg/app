import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { Timer } from '../ports/timer';
import type { Alert } from '../monitoring/alert-rules';
import type { DashboardMetrics } from '../monitoring/dashboard-metrics';

/** What a job learns about its run. */
export interface JobContext {
    /** When Cloudflare scheduled the run, in milliseconds since the Unix epoch. */
    readonly scheduledTime: number;
    /** Aborts when the job's time is up; a job must stop then. */
    readonly signal: AbortSignal;
}

/**
 * A job for the Worker's one `scheduled` handler (I-04). To add one (I-05, I-07): implement this, add it to the list in
 * `app/scheduled.ts`, and put its cron expression into `triggers.crons` in wrangler.jsonc for every environment; a test
 * fails if the two disagree.
 */
export interface ScheduledJob {
    /** Stable, lower-case and dashed (`relay-monitor`): it names the job in logs, metrics and alerts. */
    readonly name: string;
    /** The cron expression this job runs on, exactly as in `triggers.crons`. */
    readonly cron: string;
    /** Resolves when done; a rejection or a throw is a failed run. */
    run(context: JobContext): Promise<void>;
}

export const JOB_NAME = /^[a-z][a-z0-9-]{0,40}$/;

export interface JobResult {
    readonly job: string;
    readonly outcome: 'ok' | 'failed';
    readonly durationMs: number;
}

export interface DispatcherDeps {
    readonly jobs: readonly ScheduledJob[];
    readonly clock: Clock;
    readonly timer: Timer;
    readonly logger: Logger;
    readonly metrics: DashboardMetrics;
    /** Records each run (the job-failure streaks) and answers the alerts it starts or ends. */
    readonly recordRun: (run: {
        readonly job: string;
        readonly outcome: 'ok' | 'failed';
        readonly at: number;
    }) => Promise<readonly Alert[]>;
    readonly deliver: (alerts: readonly Alert[]) => Promise<void>;
    /** A job still running after this has failed, and its signal aborts. */
    readonly jobTimeoutMs: number;
}

export interface ScheduledDispatcher {
    /** Runs every job registered for `cron`, side by side; never rejects. */
    dispatch(cron: string, scheduledTime: number): Promise<readonly JobResult[]>;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

export function createScheduledDispatcher(deps: DispatcherDeps): ScheduledDispatcher {
    const names = new Set<string>();
    for (const job of deps.jobs) {
        if (!JOB_NAME.test(job.name) || names.has(job.name)) {
            throw new Error(`scheduled job names must be unique and dashed: ${job.name}`);
        }
        names.add(job.name);
    }

    async function runOne(job: ScheduledJob, scheduledTime: number): Promise<JobResult> {
        const startedAt = deps.clock.nowMs();
        const controller = new AbortController();
        const stopTimer = new AbortController();
        let outcome: JobResult['outcome'];
        try {
            const finished = Promise.resolve().then(() => job.run({ scheduledTime, signal: controller.signal }));
            const timedOut = deps.timer.wait(deps.jobTimeoutMs, stopTimer.signal).then(() => 'timeout' as const);
            const first = await Promise.race([finished.then(() => 'done' as const), timedOut]);
            if (first === 'timeout') {
                controller.abort(new Error('job timed out'));
                // A job that ignores its signal keeps running in the background; it has failed either way.
                finished.catch(() => undefined);
                deps.logger.error('cron.job-failed', { job: job.name, problem: 'timeout' });
                outcome = 'failed';
            } else {
                outcome = 'ok';
            }
        } catch (error) {
            deps.logger.error('cron.job-failed', { job: job.name, problem: errorName(error) });
            outcome = 'failed';
        } finally {
            stopTimer.abort();
        }
        const durationMs = deps.clock.nowMs() - startedAt;
        deps.metrics.record({ name: 'ptbk_dashboard_cron_runs_total', job: job.name, outcome, durationMs });
        try {
            await deps.deliver(await deps.recordRun({ job: job.name, outcome, at: deps.clock.nowMs() }));
        } catch (error) {
            deps.logger.error('cron.record-failed', { job: job.name, problem: errorName(error) });
        }
        return { job: job.name, outcome, durationMs };
    }

    return {
        async dispatch(cron, scheduledTime) {
            const due = deps.jobs.filter((job) => job.cron === cron);
            if (due.length === 0) deps.logger.warn('cron.no-jobs', { cron });
            return Promise.all(due.map((job) => runOne(job, scheduledTime)));
        },
    };
}
