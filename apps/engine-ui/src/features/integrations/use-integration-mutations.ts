import type { CreateIntegrationBody, IntegrationId, ReadIntegration, UpdateIntegrationBody } from '@ptbk/engine-api';
import { useToast } from '@ptbk/ui';
import type { ToastInput } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { unwrap } from '../../app/api-errors';
import type { ApiFailure } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { restoreIntegration, snapshotIntegration, updateCachedIntegration } from './integration-cache';
import type { IntegrationCacheSnapshot } from './integration-cache';
import { integrationKeys } from './integrations-keys';

/** Mutations are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const MUTATION_TIMEOUT_MS = 30_000;
/** A check waits for the engine to re-test the connection, which may reach a slow third party. */
const CHECK_TIMEOUT_MS = 60_000;

const INVALIDATES = [integrationKeys.lists(), integrationKeys.details(), integrationKeys.allStats()] as const;

/** The integration a mutation acts on; `name` is for messages only. */
export interface IntegrationTarget {
    readonly id: IntegrationId;
    readonly name: string;
}

export interface IntegrationUpdate extends IntegrationTarget {
    readonly body: z.input<typeof UpdateIntegrationBody>;
}

function problemCode(failure: ApiFailure): string | null {
    return failure.kind === 'problem' ? failure.problem.code : null;
}

/** What a check found, in the tone of the outcome: only a working connection is a success. */
export function checkOutcome(integration: ReadIntegration): ToastInput {
    const name = integration.name;
    const unusable = integration.secretRefs.filter(({ state }) => state !== 'resolved').map((ref) => ref.name);
    switch (integration.status) {
        case 'connected':
            return { tone: 'success', title: m.integration_checked_connected({ name }) };
        case 'needs-attention':
            return {
                tone: 'warning',
                title:
                    unusable.length === 0
                        ? m.integration_checked_attention({ name })
                        : m.integration_checked_missing({ name, secrets: unusable.join(', ') }),
            };
        case 'error':
            return { tone: 'danger', title: m.integration_checked_error({ name }) };
        case 'disconnected':
            return { tone: 'info', title: m.integration_checked_disabled({ name }) };
        case 'unknown':
            return { tone: 'info', title: m.integration_checked_unknown({ name }) };
    }
}

/**
 * Every change to an integration. Enable and disable are optimistic and roll back with a failure toast; the others
 * wait for the engine, since their outcome (a new status, a refused name) is the engine's to decide. No variable here
 * carries a secret value: integrations reference secrets by name only.
 */
export function useIntegrationMutations() {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const toast = useToast();
    const signal = (ms = MUTATION_TIMEOUT_MS) => AbortSignal.timeout(ms);
    const settle = (integration: ReadIntegration) => {
        updateCachedIntegration(queryClient, integration.id, () => integration);
    };
    const optimisticStatus = (status: ReadIntegration['status']) => ({
        apply: (target: IntegrationTarget, client: typeof queryClient) => {
            const snapshot = snapshotIntegration(client, target.id);
            updateCachedIntegration(client, target.id, (cached) => ({ ...cached, status, statusDetail: null }));
            return snapshot;
        },
        rollback: (snapshot: IntegrationCacheSnapshot, client: typeof queryClient) => {
            restoreIntegration(client, snapshot);
        },
    });

    const create = useStepUpAwareMutation({
        mutationFn: async (body: z.input<typeof CreateIntegrationBody>) =>
            unwrap(await engineApi.integrations.create(body, signal())),
        invalidates: INVALIDATES,
        successMessage: (integration) => m.integration_created({ name: integration.name }),
        errorMessage: (failure, { name }) =>
            problemCode(failure) === 'name-taken'
                ? m.integration_name_taken({ name })
                : m.integration_create_failed({ name }),
    });

    const update = useStepUpAwareMutation({
        mutationFn: async ({ id, body }: IntegrationUpdate) =>
            unwrap(await engineApi.integrations.update(id, body, signal())),
        invalidates: INVALIDATES,
        successMessage: (integration) => m.integration_saved({ name: integration.name }),
        errorMessage: (failure, { name, body }) =>
            problemCode(failure) === 'name-taken'
                ? m.integration_name_taken({ name: body.name ?? name })
                : m.integration_save_failed({ name }),
        onSuccess: settle,
    });

    const enable = useStepUpAwareMutation<ReadIntegration, IntegrationTarget, IntegrationCacheSnapshot>({
        mutationFn: async ({ id }) => unwrap(await engineApi.integrations.enable(id, signal())),
        invalidates: INVALIDATES,
        optimistic: optimisticStatus('connected'),
        errorMessage: (_, { name }) => m.integration_enable_failed({ name }),
        onSuccess: settle,
    });

    const disable = useStepUpAwareMutation<ReadIntegration, IntegrationTarget, IntegrationCacheSnapshot>({
        mutationFn: async ({ id }) => unwrap(await engineApi.integrations.disable(id, signal())),
        invalidates: INVALIDATES,
        optimistic: optimisticStatus('disconnected'),
        errorMessage: (_, { name }) => m.integration_disable_failed({ name }),
        onSuccess: settle,
    });

    const check = useStepUpAwareMutation({
        mutationFn: async ({ id }: IntegrationTarget) =>
            unwrap(await engineApi.integrations.check(id, signal(CHECK_TIMEOUT_MS))),
        invalidates: INVALIDATES,
        errorMessage: (_, { name }) => m.integration_check_failed({ name }),
        onSuccess: (integration) => {
            toast.show(checkOutcome(integration));
            settle(integration);
        },
    });

    const remove = useStepUpAwareMutation({
        mutationFn: async ({ id }: IntegrationTarget) => unwrap(await engineApi.integrations.delete(id, signal())),
        invalidates: [integrationKeys.lists(), integrationKeys.allStats()],
        successMessage: (_, { name }) => m.integration_deleted({ name }),
        errorMessage: (_, { name }) => m.integration_delete_failed({ name }),
        onSuccess: (_, { id }) => {
            queryClient.removeQueries({ queryKey: integrationKeys.detail(id) });
        },
    });

    return { create, update, enable, disable, check, remove };
}

export type IntegrationMutations = ReturnType<typeof useIntegrationMutations>;
