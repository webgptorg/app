import { SIGN_IN_PATH } from '@ptbk/engine-api';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../test/axe';
import { renderWithProviders } from '../test/render-with-providers';
import { createTestEngineApi, problemResponse } from '../test/test-engine-api';

describe('engine-ui app', () => {
    it('redirects / to the placeholder agents route and renders it with the in-memory client', async () => {
        const { router, container } = renderWithProviders({ path: '/' });

        expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined();
        expect(screen.getByText('Ada')).toBeDefined();
        expect(screen.getByText('Grace')).toBeDefined();
        expect(router.state.location.pathname).toBe('/agents');
        await expectNoAxeViolations(container);
    });

    it('asks for a new sign-in when the engine answers 401 unauthenticated', async () => {
        const engineApi = createTestEngineApi();
        const { onUnauthenticated } = renderWithProviders({
            path: '/agents',
            engineApi: { ...engineApi, engine: { get: () => problemResponse('unauthenticated') } },
        });

        await waitFor(() => {
            expect(onUnauthenticated).toHaveBeenCalledOnce();
        });
        expect(SIGN_IN_PATH).toBe('/auth/sign-in');
    });

    it('shows the route error for other problems, without a sign-in, and recovers on retry', async () => {
        const engineApi = createTestEngineApi();
        const agents = { ...engineApi.agents };
        vi.spyOn(agents, 'list').mockImplementationOnce(() => problemResponse('forbidden'));
        const { onUnauthenticated, user } = renderWithProviders({
            path: '/agents',
            engineApi: { ...engineApi, agents },
        });

        expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined();
        expect(onUnauthenticated).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Ada')).toBeDefined();
    });

    it('treats step-up-required as no reason to sign in again', async () => {
        const engineApi = createTestEngineApi();
        const { onUnauthenticated } = renderWithProviders({
            path: '/agents',
            engineApi: { ...engineApi, engine: { get: () => problemResponse('step-up-required') } },
        });

        expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined();
        expect(onUnauthenticated).not.toHaveBeenCalled();
    });

    it('renders the not-found placeholder with a way back', async () => {
        const { container } = renderWithProviders({ path: '/nowhere' });

        expect(await screen.findByRole('heading', { name: 'Not found' })).toBeDefined();
        expect(screen.getByRole('link', { name: 'Go to agents' }).getAttribute('href')).toBe('/agents');
        await expectNoAxeViolations(container);
    });
});

describe('router conventions', () => {
    it.each([
        ['hovering', 'hover'],
        ['focusing', 'focus'],
    ] as const)('preloads the agents route and its data on %s a link', async (_, intent) => {
        const engineApi = createTestEngineApi();
        const agents = { ...engineApi.agents };
        const list = vi.spyOn(agents, 'list');
        const { router, user } = renderWithProviders({ path: '/nowhere', engineApi: { ...engineApi, agents } });
        const link = await screen.findByRole('link', { name: 'Agents' });
        expect(list).not.toHaveBeenCalled();

        if (intent === 'hover') await user.hover(link);
        else link.focus();

        await waitFor(() => {
            expect(list).toHaveBeenCalledOnce();
        });
        expect(list.mock.calls[0]?.[0]).toEqual({ sort: 'name' });
        expect(router.state.location.pathname).toBe('/nowhere');
    });

    it('falls back to the default when a search param is invalid', async () => {
        const engineApi = createTestEngineApi();
        const agents = { ...engineApi.agents };
        const list = vi.spyOn(agents, 'list');
        const { router } = renderWithProviders({ path: '/agents?sort=bogus', engineApi: { ...engineApi, agents } });

        expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined();
        expect(router.state.location.search).toEqual({ sort: 'name' });
        expect(list.mock.calls[0]?.[0]).toEqual({ sort: 'name' });
    });

    it('keeps a valid search param', async () => {
        const { router } = renderWithProviders({ path: '/agents?sort=-updatedAt' });

        expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined();
        expect(router.state.location.search).toEqual({ sort: '-updatedAt' });
    });
});
