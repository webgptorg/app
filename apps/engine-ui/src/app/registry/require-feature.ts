import { AccessDeniedError } from '../access-denied';
import type { RouterContext } from '../router-context';
import { loadAccess } from './engine-access';
import type { FeatureDefinition } from './feature';
import { featureAccess, requirementAccess } from './visibility';

function registered(context: RouterContext, id: string): FeatureDefinition {
    const feature = context.features.find((candidate) => candidate.id === id);
    if (feature === undefined) throw new Error(`requireFeature: no feature "${id}" is registered`);
    return feature;
}

/**
 * For a route's `beforeLoad`: the route of feature `id` shows "not available on this engine" or "no access" instead
 * of its content when the engine's capabilities or the member's permissions do not allow it. With `agentTab`, that
 * tab's own requirement must be met too.
 */
export function requireFeature(id: string, options: { readonly agentTab?: string } = {}) {
    return async ({ context }: { readonly context: RouterContext }): Promise<void> => {
        const feature = registered(context, id);
        const access = await loadAccess(context);
        const featureVerdict = featureAccess(feature, access);
        if (featureVerdict !== 'allowed') throw new AccessDeniedError(featureVerdict);
        if (options.agentTab === undefined) return;
        const tab = feature.agentTabs?.find((candidate) => candidate.id === options.agentTab);
        if (tab === undefined)
            throw new Error(`requireFeature: feature "${id}" has no agent tab "${options.agentTab}"`);
        const tabVerdict = requirementAccess(tab.requires, access);
        if (tabVerdict !== 'allowed') throw new AccessDeniedError(tabVerdict);
    };
}
