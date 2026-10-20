import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { apiRoutes } from '../../shared/api/routes';
import { passkey, session, sessionSummary } from '../testing/fixtures';
import { createScriptedApi, ok, problem } from '../testing/scripted-api';
import { createFakeApiClient } from './fake-api-client';
import {
    ApiError,
    createAppQueryClient,
    dataOrThrow,
    environmentQuery,
    hasProblem,
    passkeysQuery,
    problemCode,
    sessionQuery,
    sessionsQuery,
    shouldRetryQuery,
} from './queries';

const noRetry = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('environment query', () => {
    it('resolves with the parsed data', async () => {
        const client = createFakeApiClient(
            new Map([[apiRoutes.getEnvironment, { kind: 'ok', data: { environment: 'dev' } }]]),
        );
        expect(await new QueryClient().query(environmentQuery(client))).toEqual({ environment: 'dev' });
        expect(client.calls).toEqual([apiRoutes.getEnvironment]);
    });

    it('throws an ApiError carrying the outcome for anything else', async () => {
        const client = createFakeApiClient(new Map());
        const error: unknown = await noRetry()
            .query(environmentQuery(client))
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).outcome).toEqual({ kind: 'network-error' });
        expect((error as ApiError).name).toBe('ApiError');
    });
});

describe('session query', () => {
    it('answers the session, or null when signed out', async () => {
        const signedIn = createScriptedApi().on(apiRoutes.getSession, ok(session()));
        expect(await noRetry().query(sessionQuery(signedIn))).toEqual(session());
        const signedOut = createScriptedApi().on(apiRoutes.getSession, problem(401, 'unauthorized'));
        expect(await noRetry().query(sessionQuery(signedOut))).toBeNull();
    });

    it('throws any other failure', async () => {
        const api = createScriptedApi().on(apiRoutes.getSession, problem(500, 'internal'));
        await expect(noRetry().query(sessionQuery(api))).rejects.toBeInstanceOf(ApiError);
    });
});

describe('account queries', () => {
    it('unwrap the passkey and session lists', async () => {
        const api = createScriptedApi()
            .on(apiRoutes.listPasskeys, ok({ passkeys: [passkey()] }))
            .on(apiRoutes.listSessions, ok({ sessions: [sessionSummary()] }));
        expect(await noRetry().query(passkeysQuery(api))).toEqual([passkey()]);
        expect(await noRetry().query(sessionsQuery(api))).toEqual([sessionSummary()]);
    });
});

describe('failure helpers', () => {
    it('read the problem code of an ApiError only', () => {
        const error = new ApiError({ kind: 'problem', status: 403, code: 'recovery-cooldown' });
        expect(problemCode(error)).toBe('recovery-cooldown');
        expect(hasProblem(error, 'recovery-cooldown')).toBe(true);
        expect(hasProblem(error, 'forbidden')).toBe(false);
        expect(problemCode(new ApiError({ kind: 'network-error' }))).toBeNull();
        expect(problemCode(new Error('x'))).toBeNull();
    });

    it('dataOrThrow passes data and throws the rest', () => {
        expect(dataOrThrow({ kind: 'ok', data: 1 } as never)).toBe(1);
        expect(() => dataOrThrow({ kind: 'invalid-response', status: 200 })).toThrow(ApiError);
    });

    it.each([
        ['a network error', new ApiError({ kind: 'network-error' }), 0, true],
        ['a 5xx problem', new ApiError({ kind: 'problem', status: 503, code: 'internal' }), 1, true],
        ['a 5xx breach', new ApiError({ kind: 'invalid-response', status: 502 }), 0, true],
        ['a 4xx problem', new ApiError({ kind: 'problem', status: 404, code: 'not-found' }), 0, false],
        ['a 2xx breach', new ApiError({ kind: 'invalid-response', status: 200 }), 0, false],
        ['a third attempt', new ApiError({ kind: 'network-error' }), 2, false],
        ['a non-API error', new Error('bug'), 0, false],
    ])('retries %s: %s', (_label, error, failures, expected) => {
        expect(shouldRetryQuery(failures, error)).toBe(expected);
    });
});

describe('the app query client', () => {
    it('reports a 401 from a query or a mutation as the end of the session, and nothing else', async () => {
        const onUnauthenticated = vi.fn();
        const client = createAppQueryClient({ onUnauthenticated });
        const unauthorized = new ApiError({ kind: 'problem', status: 401, code: 'unauthorized' });
        await client
            .query({ queryKey: ['a'], queryFn: () => Promise.reject(unauthorized), retry: false })
            .catch(() => undefined);
        expect(onUnauthenticated).toHaveBeenCalledTimes(1);
        await client
            .getMutationCache()
            .build(client, { mutationFn: () => Promise.reject(unauthorized) })
            .execute(undefined)
            .catch(() => undefined);
        expect(onUnauthenticated).toHaveBeenCalledTimes(2);
        await client
            .query({
                queryKey: ['b'],
                queryFn: () => Promise.reject(new ApiError({ kind: 'network-error' })),
                retry: false,
            })
            .catch(() => undefined);
        expect(onUnauthenticated).toHaveBeenCalledTimes(2);
    });
});
