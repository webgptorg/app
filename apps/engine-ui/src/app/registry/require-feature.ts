import { AccessDeniedError } from '../access-denied';
import { createCan } from '../../features/session/permissions';
import { meQueryOptions } from '../../features/session/session-queries';
import type { RouterContext } from '../router-context';
import { featureAccess } from './visibility';

/**
 * For a route's `beforeLoad`: the route of feature `id` shows "not available on this engine" or "no access" instead
 * of its content when the engine or the member's permissions do not allow it.
 */
export function requireFeature(id: string) {
    return async ({ context }: { readonly context: RouterContext }): Promise<void> => {
        const feature = context.features.find((candidate) => candidate.id === id);
        if (feature === undefined) throw new Error(`requireFeature: no feature "${id}" is registered`);
        const me = await context.queryClient.query({ ...meQueryOptions(context.engineApi), staleTime: 'static' });
        const access = featureAccess(feature, { can: createCan(me.permissions) });
        if (access !== 'allowed') throw new AccessDeniedError(access);
    };
}
