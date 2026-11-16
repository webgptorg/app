import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';

import { createFakeMatchMedia } from '../testing/fake-match-media';
import { FEATURES } from './features';
import { createAppQueryClient } from './query-client';
import { ROUTE_VIEW_TRANSITION, createAppRouter, preloadMatchedRouteChunks } from './router';
import { createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';

function createContext() {
    return {
        engineApi: createInMemoryEngineApiClient(),
        queryClient: createAppQueryClient({ onUnauthenticated: () => undefined }),
        features: FEATURES,
    };
}

describe('preloadMatchedRouteChunks', () => {
    it('starts the chunks of every route the URL matches before the router has run a guard', () => {
        const history = createMemoryHistory({ initialEntries: ['/agents/ada/chat/'] });
        const router = createAppRouter(createContext(), { history });
        const loadRouteChunk = vi.spyOn(router, 'loadRouteChunk').mockReturnValue(Promise.reject(new Error('offline')));

        preloadMatchedRouteChunks(router);

        expect(loadRouteChunk.mock.calls.map(([route]) => String(route.id))).toEqual([
            '__root__',
            '/agents',
            '/agents/$agentId',
            '/agents/$agentId/chat',
            '/agents/$agentId/chat/',
        ]);
        expect(router.state.status).toBe('idle');
    });
});

describe('view transitions', () => {
    it('animate a change of route, never a change of search params alone', () => {
        const from = { pathname: '/agents' };
        expect(ROUTE_VIEW_TRANSITION.types({ fromLocation: from, pathChanged: true })).toEqual(['route']);
        expect(ROUTE_VIEW_TRANSITION.types({ fromLocation: from, pathChanged: false })).toBe(false);
    });

    it('leave the first load alone, which has no route to morph from', () => {
        expect(ROUTE_VIEW_TRANSITION.types({ fromLocation: undefined, pathChanged: true })).toBe(false);
    });

    it('are off under reduced motion', () => {
        const context = createContext();
        const reduced = createFakeMatchMedia({ '(prefers-reduced-motion: reduce)': true });
        expect(createAppRouter(context, { matchMedia: reduced.matchMedia }).options.defaultViewTransition).toBe(false);
        expect(
            createAppRouter(context, { matchMedia: createFakeMatchMedia().matchMedia }).options.defaultViewTransition,
        ).toBe(ROUTE_VIEW_TRANSITION);
    });
});
