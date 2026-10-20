import { createProblem } from '@ptbk/engine-api';
import { describe, expect, it, vi } from 'vitest';

import { EngineApiProblemError, shouldRetryQuery } from './api-errors';
import { createAppQueryClient } from './query-client';

const fail = (code: Parameters<typeof createProblem>[0]) => () =>
    Promise.reject(new EngineApiProblemError(createProblem(code)));

describe('createAppQueryClient', () => {
    it('uses the retry policy and refetches on window focus', () => {
        const queries = createAppQueryClient({ onUnauthenticated: vi.fn() }).getDefaultOptions().queries;
        expect(queries?.retry).toBe(shouldRetryQuery);
        expect(queries?.refetchOnWindowFocus).toBe(true);
    });

    it('reports an unauthenticated query or mutation', async () => {
        const onUnauthenticated = vi.fn();
        const client = createAppQueryClient({ onUnauthenticated });

        await expect(client.query({ queryKey: ['q'], queryFn: fail('unauthenticated') })).rejects.toThrow();
        await expect(
            client
                .getMutationCache()
                .build(client, { mutationFn: fail('unauthenticated') })
                .execute(undefined),
        ).rejects.toThrow();

        expect(onUnauthenticated).toHaveBeenCalledTimes(2);
    });

    it('ignores every other failure', async () => {
        const onUnauthenticated = vi.fn();
        const client = createAppQueryClient({ onUnauthenticated });

        await expect(client.query({ queryKey: ['q'], queryFn: fail('step-up-required') })).rejects.toThrow();
        await expect(client.query({ queryKey: ['r'], queryFn: fail('forbidden') })).rejects.toThrow();

        expect(onUnauthenticated).not.toHaveBeenCalled();
    });
});
