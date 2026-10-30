import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryKey, UseMutationResult } from '@tanstack/react-query';
import { useLocale as useFormatters, useToast } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import type { SessionView } from '../../shared/api/routes';
import { ApiError, hasProblem, queryKeys } from '../api/queries';
import { StepUpFailedError, useStepUp } from '../features/step-up/step-up';
import type { StepUpMode } from '../features/step-up/step-up';

export interface AppMutationOptions<Data, Variables> {
    readonly mutationFn: (variables: Variables) => Promise<Data>;
    /** Queries refetched once the mutation settles, whatever the outcome. */
    readonly invalidates?: readonly QueryKey[];
    readonly successMessage?: (data: Data, variables: Variables) => string;
    /** The failure text for errors this mutation knows; `undefined` falls back to the common ones. */
    readonly errorMessage?: (error: unknown) => string | undefined;
    readonly onSuccess?: (data: Data, variables: Variables) => void | Promise<void>;
    /** `in-place` for actions confirmed in a dialog: a failed passkey check is shown there, not in a toast. */
    readonly stepUp?: StepUpMode;
}

/** Ends of the recovery cooldown and similar instants, in the person's locale. */
type FormatDateTime = (value: Date) => string;

function commonErrorMessage(error: unknown, recoveryCooldownEndsAt: number | null, format: FormatDateTime): string {
    if (hasProblem(error, 'recovery-cooldown')) {
        return recoveryCooldownEndsAt === null
            ? m.error_recovery_cooldown_generic()
            : m.error_recovery_cooldown({ until: format(new Date(recoveryCooldownEndsAt)) });
    }
    if (hasProblem(error, 'step-up-required')) {
        return m.error_step_up_cancelled();
    }
    if (hasProblem(error, 'forbidden')) {
        return m.error_forbidden();
    }
    if (hasProblem(error, 'rate-limited')) {
        return m.api_error_rate_limited();
    }
    if (error instanceof ApiError && error.outcome.kind === 'network-error') {
        return m.api_error_unreachable();
    }
    return m.error_mutation_failed();
}

/**
 * The one way the dashboard changes data: a `step-up-required` answer runs the step-up dialog and retries, every
 * failure is reported in a toast, and success is reported where the screen asks for it. None of D-09's mutations is
 * optimistic: adding a passkey needs the authenticator first, and removals and sign-outs must not pretend to succeed.
 */
export function useAppMutation<Data, Variables = void>(
    options: AppMutationOptions<Data, Variables>,
): UseMutationResult<Data, unknown, Variables> {
    const queryClient = useQueryClient();
    const toast = useToast();
    const { withStepUp } = useStepUp();
    const formatters = useFormatters();
    return useMutation<Data, unknown, Variables>({
        mutationFn: (variables) => withStepUp(() => options.mutationFn(variables), options.stepUp),
        onError: (error) => {
            if (error instanceof StepUpFailedError) {
                return;
            }
            const session = queryClient.getQueryData<SessionView | null>(queryKeys.session);
            const recoveryCooldownEndsAt = session?.user.recoveryCooldownEndsAt ?? null;
            const title =
                options.errorMessage?.(error) ??
                commonErrorMessage(error, recoveryCooldownEndsAt, (value) => formatters.formatDateTime(value));
            toast.show({ tone: 'danger', title });
        },
        onSuccess: async (data, variables) => {
            const message = options.successMessage?.(data, variables);
            if (message !== undefined) {
                toast.show({ tone: 'success', title: message });
            }
            await options.onSuccess?.(data, variables);
        },
        onSettled: () =>
            Promise.all((options.invalidates ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
    });
}
