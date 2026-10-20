import type { Can } from '../../features/session/permissions';
import type { FeatureDefinition, FeatureRequirement } from './feature';

export interface Access {
    readonly can: Can;
}

export function isAllowed(requires: FeatureRequirement | undefined, access: Access): boolean {
    return requires?.permission === undefined || access.can(requires.permission);
}

/** Why a feature's route cannot be shown, checked in the order the member would want to hear it. */
export function featureAccess(feature: FeatureDefinition, access: Access): 'allowed' | 'no-access' {
    return isAllowed(feature.requires, access) ? 'allowed' : 'no-access';
}

/** The features the member may use, each with only the nested entries their own requirements allow. */
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
