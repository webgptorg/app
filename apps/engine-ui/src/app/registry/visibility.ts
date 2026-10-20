import type { CapabilityRef } from '@ptbk/engine-api';

import type { Can } from '../../features/session/permissions';
import type { FeatureDefinition, FeatureRequirement } from './feature';

export interface Access {
    readonly can: Can;
    /** Whether the engine advertises a capability version; unknown capabilities never match. */
    readonly supports: (capability: CapabilityRef) => boolean;
}

export type FeatureAccess = 'allowed' | 'unavailable' | 'no-access';

/** Why something cannot be shown, capability first: "not available on this engine" says more than "no access". */
export function requirementAccess(requires: FeatureRequirement | undefined, access: Access): FeatureAccess {
    if (requires?.capability !== undefined && !access.supports(requires.capability)) return 'unavailable';
    if (requires?.permission !== undefined && !access.can(requires.permission)) return 'no-access';
    if (requires?.anyPermission !== undefined && !requires.anyPermission.some((permission) => access.can(permission))) {
        return 'no-access';
    }
    return 'allowed';
}

export function isAllowed(requires: FeatureRequirement | undefined, access: Access): boolean {
    return requirementAccess(requires, access) === 'allowed';
}

export function featureAccess(feature: FeatureDefinition, access: Access): FeatureAccess {
    return requirementAccess(feature.requires, access);
}

/** The features the engine and the member allow, each with only the nested entries their own requirements allow. */
export function visibleFeatures(features: readonly FeatureDefinition[], access: Access): FeatureDefinition[] {
    const allowed = <Entry extends { readonly requires?: FeatureRequirement }>(entries: readonly Entry[]) =>
        entries.filter((entry) => isAllowed(entry.requires, access));
    return features
        .filter((feature) => isAllowed(feature.requires, access))
        .map((feature) => {
            const filtered: { -readonly [Key in keyof FeatureDefinition]: FeatureDefinition[Key] } = { ...feature };
            if (feature.agentTabs !== undefined) filtered.agentTabs = allowed(feature.agentTabs);
            if (feature.agentOverviewCards !== undefined) {
                filtered.agentOverviewCards = allowed(feature.agentOverviewCards);
            }
            if (feature.commands !== undefined) filtered.commands = allowed(feature.commands);
            return filtered;
        });
}
