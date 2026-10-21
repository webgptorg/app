import type { SecretId, SecretScope } from '@ptbk/engine-api';
import type { z } from 'zod';

import { unwrap } from '../../app/api-errors';
import type { ApiFailure } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import type { OneTimeValue } from './one-time-value';
import { secretKeys } from './secrets-keys';

/** Mutations are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const MUTATION_TIMEOUT_MS = 30_000;

const INVALIDATES = [secretKeys.lists()] as const;

/** The secret a mutation acts on; the name is for messages only. */
export interface SecretTarget {
    readonly id: SecretId;
    readonly name: string;
}

export interface NewSecret {
    readonly name: string;
    readonly scope: z.input<typeof SecretScope>;
    readonly value: OneTimeValue;
}

export interface NewSecretValue extends SecretTarget {
    readonly value: OneTimeValue;
}

function problemCode(failure: ApiFailure): string | null {
    return failure.kind === 'problem' ? failure.problem.code : null;
}

/**
 * Every change to a secret. None is optimistic: each is security-relevant and may need step-up, so the table changes
 * only once the engine confirmed it. Toasts name the secret, never its value.
 */
export function useSecretMutations() {
    const engineApi = useEngineApi();
    const signal = () => AbortSignal.timeout(MUTATION_TIMEOUT_MS);

    const create = useStepUpAwareMutation({
        mutationFn: async ({ name, scope, value }: NewSecret) =>
            unwrap(await engineApi.secrets.create({ name, scope, value: value.take() }, signal())),
        invalidates: INVALIDATES,
        successMessage: (secret) => m.secrets_created({ name: secret.name }),
        errorMessage: (failure, { name }) =>
            problemCode(failure) === 'name-taken' ? m.secrets_name_taken({ name }) : m.secrets_create_failed({ name }),
    });

    const replace = useStepUpAwareMutation({
        mutationFn: async ({ id, value }: NewSecretValue) =>
            unwrap(await engineApi.secrets.replaceValue(id, { value: value.take() }, signal())),
        invalidates: INVALIDATES,
        successMessage: (_, { name }) => m.secrets_replaced({ name }),
        errorMessage: (failure, { name }) =>
            problemCode(failure) === 'secret-revoked'
                ? m.secrets_replace_revoked({ name })
                : m.secrets_replace_failed({ name }),
    });

    const revoke = useStepUpAwareMutation({
        mutationFn: async ({ id }: SecretTarget) => unwrap(await engineApi.secrets.revoke(id, signal())),
        invalidates: INVALIDATES,
        successMessage: (_, { name }) => m.secrets_revoked({ name }),
        errorMessage: (_, { name }) => m.secrets_revoke_failed({ name }),
    });

    const remove = useStepUpAwareMutation({
        mutationFn: async ({ id }: SecretTarget) => unwrap(await engineApi.secrets.delete(id, signal())),
        invalidates: INVALIDATES,
        successMessage: (_, { name }) => m.secrets_deleted({ name }),
        errorMessage: (_, { name }) => m.secrets_delete_failed({ name }),
    });

    return { create, replace, revoke, remove };
}

export type SecretMutations = ReturnType<typeof useSecretMutations>;
