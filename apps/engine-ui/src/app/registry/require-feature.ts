import { AccessDeniedError } from '../access-denied';
import type { RouterContext } from '../router-context';
import { loadAccess } from './engine-access';
import { featureAccess } from './visibility';

/**
 * For a route's `beforeLoad`: the route of feature `id` shows "not available on this engine" or "no access" instead
 * of its content when the engine's capabilities or the member's permissions do not allow it.
 */
export function requireFeature(id: string) {
    return async ({ context }: { readonly context: RouterContext }): Promise<void> => {
        const feature = context.features.find((candidate) => candidate.id === id);
        if (feature === undefined) throw new Error(`requireFeature: no feature "${id}" is registered`);
        const access = featureAccess(feature, await loadAccess(context));
        if (access !== 'allowed') throw new AccessDeniedError(access);
    };
}
