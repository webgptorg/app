import type { AbuseFeedJobDeps } from '../domain/abuse/abuse-feed-job';
import { runAbuseFeedCheck } from '../domain/abuse/abuse-feed-job';
import type { CtWatchDeps } from '../domain/abuse/ct-watch';
import { runCtWatch } from '../domain/abuse/ct-watch';
import type { PublicFaceJobDeps } from '../domain/abuse/public-face-job';
import { runPublicFaceCheck } from '../domain/abuse/public-face-job';
import type { MonitoringJobDeps } from '../domain/monitoring/monitoring-job';
import { runMonitoring } from '../domain/monitoring/monitoring-job';
import type { ScheduledJob } from '../domain/scheduled/scheduled-dispatcher';

/** Every minute: the relay monitor. */
export const EVERY_MINUTE = '* * * * *';
/** Every 15 minutes: I-05's abuse jobs, in their own invocation with its own subrequest budget. */
export const EVERY_15_MINUTES = '*/15 * * * *';
/** Cron Triggers may run 15 minutes; a job that needs more than this has failed, and the next minute's run starts. */
export const JOB_TIMEOUT_MS = 50_000;

/** I-05; null without `MONITORING`, whose alert pipeline they report through. */
export interface AbuseJobDeps {
    readonly ctWatch: CtWatchDeps;
    readonly publicFace: PublicFaceJobDeps;
    /** Null until a feed provider is chosen and its adapter wired. */
    readonly abuseFeeds: AbuseFeedJobDeps | null;
}

export interface ScheduledJobDeps {
    /** Null without `MONITORING`. */
    readonly monitoring: MonitoringJobDeps | null;
    readonly abuse: AbuseJobDeps | null;
}

/**
 * The registered jobs. I-07 adds its own here (see `ScheduledJob`); every job's cron must be in `triggers.crons`,
 * which scheduled-jobs.test.ts checks.
 */
export function scheduledJobs(deps: ScheduledJobDeps): readonly ScheduledJob[] {
    const { monitoring, abuse } = deps;
    const jobs: ScheduledJob[] = [];
    if (monitoring !== null) {
        jobs.push({
            name: 'relay-monitor',
            cron: EVERY_MINUTE,
            run: ({ signal }) => runMonitoring(monitoring, signal),
        });
    }
    if (abuse !== null) {
        jobs.push(
            { name: 'ct-watch', cron: EVERY_15_MINUTES, run: ({ signal }) => runCtWatch(abuse.ctWatch, signal) },
            {
                name: 'public-face',
                cron: EVERY_15_MINUTES,
                run: ({ signal }) => runPublicFaceCheck(abuse.publicFace, signal),
            },
        );
        const feeds = abuse.abuseFeeds;
        if (feeds !== null) {
            jobs.push({
                name: 'abuse-feeds',
                cron: EVERY_15_MINUTES,
                run: ({ signal }) => runAbuseFeedCheck(feeds, signal),
            });
        }
    }
    return jobs;
}
