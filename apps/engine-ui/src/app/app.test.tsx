import { SIGN_IN_PATH, STEP_UP_PATH } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../testing/axe';
import { renderWithProviders } from '../testing/render-with-providers';
import { createTestEngineApi, problemResponse } from '../testing/test-engine-api';

describe('engine-ui app', () => {
    it('renders home at / with the in-memory client', async () => {
        const { router, container } = renderWithProviders({ path: '/' });

        expect(
            await screen.findByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Owner$/ }),
        ).toBeDefined();
        expect(await screen.findByRole('link', { name: 'Ada' })).toBeDefined();
        expect(router.state.location.pathname).toBe('/');
        await expectNoAxeViolations(container);
    });

    it('asks for a new sign-in when the engine answers 401 unauthenticated', async () => {
        const engineApi = createTestEngineApi();
        const { onUnauthenticated } = renderWithProviders({
            path: '/agents',
            engineApi: { ...engineApi, engine: { get: () => problemResponse('unauthenticated') } },
        });

        await waitFor(() => {
            expect(onUnauthenticated).toHaveBeenCalled();
        });
        expect(SIGN_IN_PATH).toBe('/auth/sign-in');
    });

    it('shows the route error when a loader throws, without a sign-in, and recovers on retry', async () => {
        const engineApi = createTestEngineApi();
        const agents = { ...engineApi.agents };
        vi.spyOn(agents, 'get').mockImplementationOnce(() => problemResponse('validation-failed'));
        const { onUnauthenticated, user } = renderWithProviders({
            path: '/agents/seed-agent-000001',
            engineApi: { ...engineApi, agents },
        });

        expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined();
        expect(screen.getByRole('alert')).toBeDefined();
        expect(onUnauthenticated).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Ada' })).toBeDefined();
    });

    it('says "no access" for a 403 instead of failing, as for a missing permission', async () => {
        const engineApi = createTestEngineApi();
        const agents = { ...engineApi.agents };
        vi.spyOn(agents, 'list').mockImplementation(() => problemResponse('forbidden'));
        const { container } = renderWithProviders({ path: '/agents', engineApi: { ...engineApi, agents } });

        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
        expect(screen.getByText(/Ask an owner or admin/)).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('treats step-up-required as no reason to sign in again, and offers the step-up page', async () => {
        const engineApi = createTestEngineApi();
        const agents = { ...engineApi.agents };
        vi.spyOn(agents, 'list').mockImplementation(() => problemResponse('step-up-required'));
        const { onUnauthenticated, user, location } = renderWithProviders({
            path: '/agents?sort=name',
            engineApi: { ...engineApi, agents },
        });

        expect(await screen.findByRole('heading', { level: 1, name: 'Confirm it is you' })).toBeDefined();
        expect(onUnauthenticated).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Continue with passkey' }));
        const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await user.click(within(dialog).getByRole('button', { name: 'Continue with passkey' }));
        expect(location.assign).toHaveBeenCalledWith(`${STEP_UP_PATH}?returnTo=%2Fagents%3Fsort%3Dname`);
    });

    it('renders the not-found state with a way back Home', async () => {
        const { container } = renderWithProviders({ path: '/nowhere' });

        expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeDefined();
        expect(screen.getByRole('link', { name: 'Go to Home' }).getAttribute('href')).toBe('/');
        await expectNoAxeViolations(container);
    });

    it('greets a member without permissions at / too', async () => {
        const { router } = renderWithProviders({ path: '/', permissions: [] });

        expect(await screen.findByRole('heading', { level: 1, name: /, Owner$/ })).toBeDefined();
        expect(router.state.location.pathname).toBe('/');
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
        expect(list.mock.calls[0]?.[0]).toEqual({ sort: '-updatedAt' });
        expect(router.state.location.pathname).toBe('/nowhere');
    });

    it('falls back to the default when a search param is invalid', async () => {
        const engineApi = createTestEngineApi();
        const agents = { ...engineApi.agents };
        const list = vi.spyOn(agents, 'list');
        const { router } = renderWithProviders({ path: '/agents?sort=bogus', engineApi: { ...engineApi, agents } });

        expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined();
        expect(router.state.location.search).toEqual({});
        expect(list.mock.calls[0]?.[0]).toEqual({ sort: '-updatedAt' });
    });

    it('keeps a valid search param', async () => {
        const { router } = renderWithProviders({ path: '/agents?sort=name' });

        expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined();
        expect(router.state.location.search).toEqual({ sort: 'name' });
    });
});
