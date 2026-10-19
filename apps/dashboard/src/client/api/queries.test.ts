import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../shared/api/routes';
import { createFakeApiClient } from './fake-api-client';
import { ApiError, environmentQuery } from './queries';

describe('environment query', () => {
    it('resolves with the parsed data', async () => {
        const client = createFakeApiClient(
            new Map([[apiRoutes.getEnvironment, { kind: 'ok', data: { environment: 'dev' } }]]),
        );
        expect(await new QueryClient().query(environmentQuery(client))).toEqual({ environment: 'dev' });
    });

    it('throws an ApiError carrying the outcome for anything else', async () => {
        const client = createFakeApiClient(new Map());
        const error: unknown = await new QueryClient({ defaultOptions: { queries: { retry: false } } })
            .query(environmentQuery(client))
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).outcome).toEqual({ kind: 'network-error' });
    });
});
