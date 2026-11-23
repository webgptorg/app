import { QueryClient } from '@tanstack/react-query';
import { isNotFound } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import type { SessionView } from '../../../shared/api/routes';
import type { Environment } from '../../../shared/environment';
import { session } from '../../testing/fixtures';
import { createScriptedApi, ok, problem } from '../../testing/scripted-api';
import { createFragmentTokens } from '../auth/fragment-token';
import { requireBillingScreen } from './billing-screen-route';

const LICENSE_READER = ['org.read', 'license.read'];

function guard(sessionView: SessionView, environment: Environment | 'unavailable') {
    const api = createScriptedApi().on(
        apiRoutes.getEnvironment,
        environment === 'unavailable' ? problem(503, 'unavailable') : ok({ environment }),
    );
    return requireBillingScreen({
        queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        apiClient: api,
        fragmentTokens: createFragmentTokens(),
        session: sessionView,
    });
}

async function notFoundThrown(result: Promise<unknown>): Promise<boolean> {
    try {
        await result;
        return false;
    } catch (error) {
        return isNotFound(error);
    }
}

describe('the billing route’s guard', () => {
    it('shows ptbk.io’s screen to whoever may read the licence', async () => {
        await expect(
            guard(session({ licensing: true, billingEnabled: false, permissions: LICENSE_READER }), 'production'),
        ).resolves.toBe('website');
    });

    it('answers not found for the website screen without license.read, as /license does', async () => {
        expect(await notFoundThrown(guard(session({ licensing: true, billingEnabled: false }), 'production'))).toBe(
            true,
        );
    });

    it('answers not found with billing off', async () => {
        expect(await notFoundThrown(guard(session({ billingEnabled: false }), 'dev'))).toBe(true);
    });

    it.each(['dev', 'staging', 'production'] as const)('keeps the Checkout in %s', async (environment) => {
        await expect(guard(session(), environment)).resolves.toBe('checkout');
    });

    it('still decides when the environment does not load', async () => {
        await expect(guard(session(), 'unavailable')).resolves.toBe('checkout');
        await expect(
            guard(session({ licensing: true, billingEnabled: false, permissions: LICENSE_READER }), 'unavailable'),
        ).resolves.toBe('website');
    });
});
