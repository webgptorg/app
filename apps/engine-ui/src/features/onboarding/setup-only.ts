import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { loadAccess } from '../../app/registry/engine-access';
import { useAllows } from '../../app/registry/use-visible-features';
import { isAllowed } from '../../app/registry/visibility';
import type { RouterContext } from '../../app/router-context';
import { ONBOARDING_REQUIREMENT } from './onboarding-feature';
import { isSetupOnly, onboardingQueryOptions } from './onboarding-queries';

/**
 * For the root guard: whether this engine is still in setup with nothing else to show. The cached state is enough;
 * the setup page keeps it current, and every answer replaces it.
 */
export async function loadSetupOnly(context: RouterContext): Promise<boolean> {
    try {
        if (!isAllowed(ONBOARDING_REQUIREMENT, await loadAccess(context))) return false;
        const state = await context.queryClient.query({
            ...onboardingQueryOptions(context.engineApi),
            staleTime: 'static',
        });
        return isSetupOnly(state);
    } catch {
        // The shell's own loaders report an engine that cannot be reached; setup is no reason to hide that.
        return false;
    }
}

/**
 * For the shell: the same answer, following the cached state as setup moves on, without polling of its own. Not
 * `'static'`: one observer with that makes TanStack skip the query in every invalidation, so a stale answer on the
 * setup page would never read the state again.
 */
export function useSetupOnly(): boolean {
    const allowed = useAllows(ONBOARDING_REQUIREMENT);
    const state = useQuery({
        ...onboardingQueryOptions(useEngineApi()),
        enabled: allowed,
        staleTime: Infinity,
        refetchInterval: false,
    });
    return allowed && isSetupOnly(state.data);
}
