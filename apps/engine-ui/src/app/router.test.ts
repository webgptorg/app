import { describe, expect, it } from 'vitest';

import { createFakeMatchMedia } from '../testing/fake-match-media';
import { FEATURES } from './features';
import { createAppQueryClient } from './query-client';
import { ROUTE_VIEW_TRANSITION, createAppRouter } from './router';
import { createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';

describe('view transitions', () => {
    it('animate a change of route, never a change of search params alone', () => {
        expect(ROUTE_VIEW_TRANSITION.types({ pathChanged: true })).toEqual(['route']);
        expect(ROUTE_VIEW_TRANSITION.types({ pathChanged: false })).toBe(false);
    });

    it('are off under reduced motion', () => {
        const context = {
            engineApi: createInMemoryEngineApiClient(),
            queryClient: createAppQueryClient({ onUnauthenticated: () => undefined }),
            features: FEATURES,
        };
        const reduced = createFakeMatchMedia({ '(prefers-reduced-motion: reduce)': true });
        expect(createAppRouter(context, { matchMedia: reduced.matchMedia }).options.defaultViewTransition).toBe(false);
        expect(
            createAppRouter(context, { matchMedia: createFakeMatchMedia().matchMedia }).options.defaultViewTransition,
        ).toBe(ROUTE_VIEW_TRANSITION);
    });
});
