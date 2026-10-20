import { NAV_GROUPS } from '../../app/registry/feature';
import type { FeatureDefinition, NavEntry, NavGroup } from '../../app/registry/feature';

export interface NavItem extends NavEntry {
    readonly featureId: string;
}

export interface NavSection {
    readonly group: NavGroup;
    readonly items: readonly NavItem[];
}

/** Sidebar sections in the order of docs/design/ui.md (work, resources, admin), each sorted, empty ones dropped. */
export function navSections(features: readonly FeatureDefinition[]): NavSection[] {
    const items = features.flatMap((feature) =>
        feature.nav === undefined ? [] : [{ ...feature.nav, featureId: feature.id }],
    );
    return NAV_GROUPS.map((group) => ({
        group,
        items: items.filter((item) => item.group === group).sort((a, b) => a.order - b.order),
    })).filter((section) => section.items.length > 0);
}
