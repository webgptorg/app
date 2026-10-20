import { STEP_UP_PATH } from '@ptbk/engine-api';
import { Button, Toaster, UiProvider } from '@ptbk/ui';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { StepUpProvider } from '../features/step-up/step-up';
import { createFakeLocation } from '../testing/fake-location';
import { problemResponse } from '../testing/test-engine-api';
import { unwrap } from './api-errors';
import { useStepUpAwareMutation } from './mutations';
import type { StepUpAwareMutationOptions } from './mutations';
import { createUiMessages } from './ui-messages';

const KEY = ['names'] as const;

function Harness({ options }: { readonly options: StepUpAwareMutationOptions<string, string, readonly string[]> }) {
    const names = useQuery({ queryKey: KEY, queryFn: () => Promise.resolve(['Ada']) });
    const mutation = useStepUpAwareMutation(options);
    return (
        <>
            <p>{names.data?.join(', ')}</p>
            <Button
                onClick={() => {
                    mutation.mutate('Grace');
                }}
            >
                {'Add'}
            </Button>
        </>
    );
}

function setUp(options: StepUpAwareMutationOptions<string, string, readonly string[]>) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const location = createFakeLocation('/agents');
    render(
        <UiProvider messages={createUiMessages()} locale="en">
            <QueryClientProvider client={queryClient}>
                <StepUpProvider location={location}>
                    <Harness options={options} />
                </StepUpProvider>
            </QueryClientProvider>
            <Toaster />
        </UiProvider>,
    );
    return { queryClient, location, user: userEvent.setup() };
}

const optimisticAdd = {
    apply: (name: string, queryClient: QueryClient) => {
        const previous = queryClient.getQueryData<readonly string[]>(KEY) ?? [];
        queryClient.setQueryData(KEY, [...previous, name]);
        return previous;
    },
    rollback: (previous: readonly string[], queryClient: QueryClient) => {
        queryClient.setQueryData(KEY, previous);
    },
};

describe('useStepUpAwareMutation', () => {
    it('applies an optimistic change, reports success and refetches on settle', async () => {
        let resolve: (value: string) => void = () => undefined;
        const mutationFn = vi.fn(() => new Promise<string>((done) => (resolve = done)));
        const { user, queryClient } = setUp({
            mutationFn,
            invalidates: [KEY],
            optimistic: optimisticAdd,
            successMessage: (_, name) => `Added ${name}`,
        });
        expect(await screen.findByText('Ada')).toBeDefined();
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

        await user.click(screen.getByRole('button', { name: 'Add' }));
        expect(await screen.findByText('Ada, Grace')).toBeDefined();
        resolve('ok');

        expect(await screen.findByText('Added Grace')).toBeDefined();
        await waitFor(() => {
            expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
        });
    });

    it('rolls the optimistic change back and reports the failure', async () => {
        const { user } = setUp({
            mutationFn: async () => unwrap(await problemResponse('validation-failed')),
            optimistic: optimisticAdd,
            invalidates: [KEY],
        });
        expect(await screen.findByText('Ada')).toBeDefined();

        await user.click(screen.getByRole('button', { name: 'Add' }));
        const region = screen.getByRole('region', { name: 'Notifications' });
        expect(await within(region).findByText('That did not work. Please try again.')).toBeDefined();
        expect(screen.getByText('Ada')).toBeDefined();
    });

    it('lets a feature word its own failure', async () => {
        const { user } = setUp({
            mutationFn: async () => unwrap(await problemResponse('agent-deleted')),
            errorMessage: (failure) => (failure.kind === 'problem' ? `Refused: ${failure.problem.code}` : 'x'),
        });
        await user.click(await screen.findByRole('button', { name: 'Add' }));
        expect(await screen.findByText('Refused: agent-deleted')).toBeDefined();
    });

    it('says "not allowed" for a 403 instead of failing', async () => {
        const { user } = setUp({ mutationFn: async () => unwrap(await problemResponse('forbidden')) });
        await user.click(await screen.findByRole('button', { name: 'Add' }));
        expect(await screen.findByText('Not allowed')).toBeDefined();
    });

    it('asks for a step-up instead of reporting an error, and hands over to the gateway', async () => {
        const { user, location } = setUp({
            mutationFn: async () => unwrap(await problemResponse('step-up-required')),
        });
        await user.click(await screen.findByRole('button', { name: 'Add' }));

        const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        expect(screen.queryByText('That did not work. Please try again.')).toBeNull();
        await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
        await waitFor(() => {
            expect(screen.queryByRole('dialog')).toBeNull();
        });

        await user.click(screen.getByRole('button', { name: 'Add' }));
        await user.click(
            within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue with passkey' }),
        );
        expect(location.assign).toHaveBeenCalledWith(`${STEP_UP_PATH}?returnTo=%2Fagents`);
    });
});
