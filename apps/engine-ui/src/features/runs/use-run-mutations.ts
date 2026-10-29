import { Timestamp } from '@ptbk/engine-api';
import type { ReadRun, RunId } from '@ptbk/engine-api';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { restoreRun, snapshotRun, updateCachedRun } from './run-cache';
import type { RunCacheSnapshot } from './run-cache';
import { runKeys } from './runs-keys';

/** Mutations are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const MUTATION_TIMEOUT_MS = 30_000;

/** The run a mutation acts on; `title` is for messages only. */
export interface RunTarget {
    readonly id: RunId;
    readonly title: string;
}

/** Cancel applies only to work that has not finished; a run already asked to stop is not asked again. */
export function canCancel(run: Pick<ReadRun, 'status' | 'cancelRequestedAt'>): boolean {
    return (run.status === 'queued' || run.status === 'running') && run.cancelRequestedAt === null;
}

/** Only a failed run can be retried (C-07); anything else answers 409 `run-not-retryable`. */
export function canRetry(run: Pick<ReadRun, 'status'>): boolean {
    return run.status === 'failed';
}

/**
 * Stop (the engine's cancel) and retry. Stop shows "Stopping…" at once, confirms with a toast once the engine accepts,
 * and rolls back with an error toast if it refuses; a run that already finished is refetched and reported as such.
 * Retry waits for the engine, then opens the new run.
 */
export function useRunMutations() {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const navigate = useNavigate();

    const cancel = useStepUpAwareMutation<ReadRun, RunTarget, RunCacheSnapshot>({
        mutationFn: async (run) =>
            unwrap(await engineApi.runs.cancel(run.id, AbortSignal.timeout(MUTATION_TIMEOUT_MS))),
        invalidates: [runKeys.lists(), runKeys.details(), runKeys.allStats()],
        optimistic: {
            apply: (run, client) => {
                const snapshot = snapshotRun(client, run.id);
                const requestedAt = Timestamp.parse(new Date().toISOString());
                updateCachedRun(client, run.id, (cached) => ({ ...cached, cancelRequestedAt: requestedAt }));
                return snapshot;
            },
            rollback: (snapshot, client) => {
                restoreRun(client, snapshot);
            },
        },
        successMessage: (_, run) => m.run_stopped({ title: run.title }),
        errorMessage: (failure, run) =>
            failure.kind === 'problem' && failure.problem.code === 'run-finished'
                ? m.run_stop_already_finished({ title: run.title })
                : m.run_stop_failed({ title: run.title }),
        onSuccess: (run) => {
            updateCachedRun(queryClient, run.id, (cached) => ({ ...cached, ...run }));
        },
    });

    const retry = useStepUpAwareMutation<ReadRun, RunTarget>({
        mutationFn: async (run) => unwrap(await engineApi.runs.retry(run.id, AbortSignal.timeout(MUTATION_TIMEOUT_MS))),
        invalidates: [runKeys.lists(), runKeys.allStats()],
        successMessage: (_, run) => m.run_retried({ title: run.title }),
        errorMessage: (failure, run) =>
            failure.kind === 'problem' && failure.problem.code === 'run-not-retryable'
                ? m.run_retry_not_retryable()
                : m.run_retry_failed({ title: run.title }),
        onSuccess: (created) => {
            void navigate({ to: '/runs/$runId', params: { runId: created.id } });
        },
    });

    return { cancel, retry };
}
