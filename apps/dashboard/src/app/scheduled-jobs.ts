import type { MonitoringJobDeps } from '../domain/monitoring/monitoring-job';
import { runMonitoring } from '../domain/monitoring/monitoring-job';
import type { ScheduledJob } from '../domain/scheduled/scheduled-dispatcher';

/** Every minute; the only expression in wrangler.jsonc's `triggers.crons` so far. */
export const EVERY_MINUTE = '* * * * *';
/** Cron Triggers may run 15 minutes; a job that needs more than this has failed, and the next minute's run starts. */
export const JOB_TIMEOUT_MS = 50_000;

export interface ScheduledJobDeps {
    /** Null without `MONITORING`. */
    readonly monitoring: MonitoringJobDeps | null;
}

/**
 * The registered jobs. I-05 and I-07 add theirs here (see `ScheduledJob`); every job's cron must be in
 * `triggers.crons`, which scheduled-jobs.test.ts checks.
 */
export function scheduledJobs(deps: ScheduledJobDeps): readonly ScheduledJob[] {
    const { monitoring } = deps;
    return monitoring === null
        ? []
        : [{ name: 'relay-monitor', cron: EVERY_MINUTE, run: ({ signal }) => runMonitoring(monitoring, signal) }];
}
