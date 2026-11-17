import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MutateOptions, QueryClient, QueryKey, UseMutationResult } from '@tanstack/react-query';
import { useToast } from '@ptbk/ui';
import { useCallback, useEffect, useRef } from 'react';

import { useAutoRetriedStepUp, useStepUp } from '../features/step-up/step-up';
import { m } from '../paraglide/messages';
import { classifyApiError } from './api-errors';
import type { ApiFailure } from './api-errors';

/** An optimistic change: `apply` edits the cache and returns what `rollback` needs to undo it. */
export interface OptimisticUpdate<Variables, Snapshot> {
    readonly apply: (variables: Variables, queryClient: QueryClient) => Snapshot;
    readonly rollback: (snapshot: Snapshot, queryClient: QueryClient) => void;
}

export interface StepUpAwareMutationOptions<Data, Variables, Snapshot> {
    readonly mutationFn: (variables: Variables) => Promise<Data>;
    /** Queries refetched once the mutation settles, whatever the outcome. */
    readonly invalidates?: readonly QueryKey[];
    /** Only where the feature brief says it is safe; the cache is restored when the engine refuses. */
    readonly optimistic?: OptimisticUpdate<Variables, Snapshot>;
    /** A success toast, where the feature brief asks for one; failures are always reported. */
    readonly successMessage?: (data: Data, variables: Variables) => string | undefined;
    /** Overrides the generic failure text for failures other than step-up and 403. */
    readonly errorMessage?: (failure: ApiFailure, variables: Variables) => string;
    readonly onSuccess?: (data: Data, variables: Variables) => void;
    /**
     * Saved when the step-up has to leave the page (the browser blocked its window), so the page can restore the form
     * or dialog on return (`useResumedStepUp` with the same `action`). Only non-secret parameters belong in `data`.
     * With `rerun`, `data` is the action's whole input: on a fresh return the mutation runs again by itself, once,
     * with `rerun(data)` (stored data is untrusted, so `rerun` parses it).
     */
    readonly resumeAs?: {
        readonly action: string;
        readonly data: (variables: Variables) => unknown;
        readonly rerun?: (data: unknown) => Variables | undefined;
    };
}

interface MutationContext<Snapshot> {
    readonly snapshot?: Snapshot;
}

type Result<Data, Variables, Snapshot> = UseMutationResult<Data, unknown, Variables, MutationContext<Snapshot>>;
type CallOptions<Data, Variables, Snapshot> = MutateOptions<Data, unknown, Variables, MutationContext<Snapshot>>;

export function isStepUpRequired(failure: ApiFailure): boolean {
    return failure.kind === 'problem' && failure.problem.code === 'step-up-required';
}

export function isForbidden(failure: ApiFailure): boolean {
    return failure.kind === 'problem' && failure.problem.status === 403;
}

/**
 * The one way features change engine data: a step-up requirement asks for the passkey and then runs the same call
 * again, a 403 says "not allowed" instead of crashing, every other failure is a toast, and an optimistic update is
 * rolled back on failure and reconciled by refetching on settle.
 */
export function useStepUpAwareMutation<Data, Variables = void, Snapshot = undefined>(
    options: StepUpAwareMutationOptions<Data, Variables, Snapshot>,
): Result<Data, Variables, Snapshot> {
    const queryClient = useQueryClient();
    const toast = useToast();
    const stepUp = useStepUp();
    // The last call's input and callbacks, in memory only, so a confirmed step-up can repeat it exactly.
    const lastCall = useRef<{ readonly variables: Variables; readonly call: CallOptions<Data, Variables, Snapshot> }>(
        undefined,
    );
    const runRef = useRef<(variables: Variables, call?: CallOptions<Data, Variables, Snapshot>) => void>(
        () => undefined,
    );
    const mutation = useMutation<Data, unknown, Variables, MutationContext<Snapshot>>({
        mutationFn: options.mutationFn,
        onMutate: async (variables) => {
            if (options.optimistic === undefined) return {};
            await Promise.all((options.invalidates ?? []).map((queryKey) => queryClient.cancelQueries({ queryKey })));
            return { snapshot: options.optimistic.apply(variables, queryClient) };
        },
        onError: (error, variables, context) => {
            if (options.optimistic !== undefined && context !== undefined && 'snapshot' in context) {
                options.optimistic.rollback(context.snapshot, queryClient);
            }
            const failure = classifyApiError(error);
            if (isStepUpRequired(failure)) {
                const resume = options.resumeAs;
                const call = lastCall.current?.variables === variables ? lastCall.current.call : {};
                stepUp.request({
                    intent:
                        resume === undefined
                            ? undefined
                            : {
                                  action: resume.action,
                                  data: resume.data(variables),
                                  ...(resume.rerun === undefined ? {} : { auto: true }),
                              },
                    retry: () => {
                        runRef.current(variables, call);
                    },
                });
                return;
            }
            if (isForbidden(failure)) {
                toast.show({ tone: 'danger', title: m.error_forbidden_title(), description: m.error_forbidden_body() });
                return;
            }
            toast.show({
                tone: 'danger',
                title: options.errorMessage?.(failure, variables) ?? m.error_mutation_failed(),
            });
        },
        onSuccess: (data, variables) => {
            const message = options.successMessage?.(data, variables);
            if (message !== undefined) toast.show({ tone: 'success', title: message });
            options.onSuccess?.(data, variables);
        },
        onSettled: () =>
            Promise.all((options.invalidates ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
    });
    const { mutate: inner } = mutation;
    const run = useCallback(
        (variables: Variables, call: CallOptions<Data, Variables, Snapshot> = {}) => {
            lastCall.current = { variables, call };
            inner(variables, call);
        },
        [inner],
    );
    useEffect(() => {
        runRef.current = run;
    }, [run]);
    const resume = options.resumeAs;
    useAutoRetriedStepUp(resume?.rerun === undefined ? undefined : resume.action, resume?.rerun, run);
    return { ...mutation, mutate: run } as Result<Data, Variables, Snapshot>;
}
