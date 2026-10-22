import type { EngineApiClient, ReadTrigger, TriggerId } from '@ptbk/engine-api';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { unwrap } from '../../app/api-errors';
import type { ApiFailure } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import type { OptimisticUpdate } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { restoreTrigger, snapshotTrigger, updateCachedTrigger } from './trigger-cache';
import type { TriggerCacheSnapshot } from './trigger-cache';
import { triggerKeys } from './triggers-keys';

/** Mutations are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const MUTATION_TIMEOUT_MS = 30_000;

/** The trigger a mutation acts on; `name` is for messages only. */
export interface TriggerTarget {
    readonly id: TriggerId;
    readonly name: string;
}

export type CreateTriggerBody = Parameters<EngineApiClient['triggers']['create']>[0];
export type UpdateTriggerBody = Parameters<EngineApiClient['triggers']['update']>[1];

/** Pause applies to a running trigger, resume to a paused or failed one; an ended one can do neither (409). */
export function canPause(trigger: Pick<ReadTrigger, 'lifecycle'>): boolean {
    return trigger.lifecycle === 'active';
}

export function canResume(trigger: Pick<ReadTrigger, 'lifecycle'>): boolean {
    return trigger.lifecycle === 'paused' || trigger.lifecycle === 'failed';
}

export function isTriggerEnded(failure: ApiFailure): boolean {
    return failure.kind === 'problem' && failure.problem.code === 'trigger-ended';
}

const EVERYTHING = [triggerKeys.lists(), triggerKeys.details(), triggerKeys.allStats()];

function optimisticLifecycle(lifecycle: 'active' | 'paused'): OptimisticUpdate<TriggerTarget, TriggerCacheSnapshot> {
    return {
        apply: (target, client) => {
            const snapshot = snapshotTrigger(client, target.id);
            updateCachedTrigger(client, target.id, (cached) => ({
                ...cached,
                lifecycle,
                rawLifecycle: lifecycle,
                ...(lifecycle === 'paused' ? { nextFireAt: null } : {}),
            }));
            return snapshot;
        },
        rollback: (snapshot, client) => {
            restoreTrigger(client, snapshot);
        },
    };
}

function settle(queryClient: QueryClient, trigger: ReadTrigger): void {
    updateCachedTrigger(queryClient, trigger.id, () => trigger);
}

/**
 * Pause and resume change the lifecycle at once and roll back with an error toast if the engine refuses; an ended
 * trigger explains why it cannot come back. Delete, create and update wait for the engine.
 */
export function useTriggerMutations() {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const timeout = () => AbortSignal.timeout(MUTATION_TIMEOUT_MS);

    const pause = useStepUpAwareMutation<ReadTrigger, TriggerTarget, TriggerCacheSnapshot>({
        mutationFn: async (target) => unwrap(await engineApi.triggers.pause(target.id, timeout())),
        invalidates: EVERYTHING,
        optimistic: optimisticLifecycle('paused'),
        successMessage: (_, target) => m.trigger_paused_toast({ name: target.name }),
        errorMessage: (failure, target) =>
            isTriggerEnded(failure) ? m.trigger_ended_message() : m.trigger_pause_failed({ name: target.name }),
        onSuccess: (trigger) => {
            settle(queryClient, trigger);
        },
    });

    const resume = useStepUpAwareMutation<ReadTrigger, TriggerTarget, TriggerCacheSnapshot>({
        mutationFn: async (target) => unwrap(await engineApi.triggers.resume(target.id, timeout())),
        invalidates: EVERYTHING,
        optimistic: optimisticLifecycle('active'),
        successMessage: (_, target) => m.trigger_resumed_toast({ name: target.name }),
        errorMessage: (failure, target) =>
            isTriggerEnded(failure) ? m.trigger_ended_message() : m.trigger_resume_failed({ name: target.name }),
        onSuccess: (trigger) => {
            settle(queryClient, trigger);
        },
    });

    const remove = useStepUpAwareMutation<null, TriggerTarget>({
        mutationFn: async (target) => unwrap(await engineApi.triggers.delete(target.id, timeout())),
        invalidates: [triggerKeys.lists(), triggerKeys.allStats()],
        successMessage: (_, target) => m.trigger_deleted_toast({ name: target.name }),
        errorMessage: (_, target) => m.trigger_delete_failed({ name: target.name }),
        onSuccess: (_, target) => {
            queryClient.removeQueries({ queryKey: triggerKeys.detail(target.id) });
        },
    });

    const create = useStepUpAwareMutation<ReadTrigger, CreateTriggerBody>({
        mutationFn: async (body) => unwrap(await engineApi.triggers.create(body, timeout())),
        invalidates: [triggerKeys.lists(), triggerKeys.allStats()],
        successMessage: (trigger) => m.trigger_created_toast({ name: trigger.name }),
        errorMessage: () => m.trigger_save_failed(),
        onSuccess: (trigger) => {
            queryClient.setQueryData(triggerKeys.detail(trigger.id), trigger);
            void navigate({ to: '/triggers/$triggerId', params: { triggerId: trigger.id } });
        },
    });

    const update = useStepUpAwareMutation<ReadTrigger, { readonly id: TriggerId; readonly body: UpdateTriggerBody }>({
        mutationFn: async ({ id, body }) => unwrap(await engineApi.triggers.update(id, body, timeout())),
        invalidates: EVERYTHING,
        successMessage: (trigger) => m.trigger_updated_toast({ name: trigger.name }),
        errorMessage: (failure) => (isTriggerEnded(failure) ? m.trigger_ended_message() : m.trigger_save_failed()),
        onSuccess: (trigger) => {
            settle(queryClient, trigger);
            void navigate({ to: '/triggers/$triggerId', params: { triggerId: trigger.id } });
        },
    });

    return { pause, resume, remove, create, update };
}
