import type { AgentId, Permission } from '@ptbk/engine-api';
import type { ComponentType } from 'react';

import type { FileRoutesByTo } from '../../routeTree.gen';

/** A route path as the router knows it, so renaming a route breaks every registry entry that names it. */
export type RoutePath = keyof FileRoutesByTo;

/** What a feature or one of its entries needs before the shell shows it. */
export interface FeatureRequirement {
    readonly permission?: Permission;
}

export const NAV_GROUPS = ['work', 'resources', 'admin'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export type NavIcon = ComponentType<{ readonly className?: string; readonly 'aria-hidden'?: boolean }>;

export interface NavEntry {
    readonly group: NavGroup;
    /** Position inside the group, lowest first; see docs/design/ui.md for the intended order. */
    readonly order: number;
    /** A catalogue message, called at render time so it follows the locale. */
    readonly label: () => string;
    readonly icon: NavIcon;
    readonly to: RoutePath;
}

export interface AgentTabEntry {
    readonly id: string;
    readonly order: number;
    readonly label: () => string;
    readonly to: RoutePath;
    readonly requires?: FeatureRequirement;
}

export interface AgentOverviewCardEntry {
    readonly id: string;
    readonly order: number;
    readonly component: ComponentType<{ readonly agentId: AgentId }>;
    readonly requires?: FeatureRequirement;
}

export type CommandEntry = {
    readonly id: string;
    readonly label: () => string;
    readonly keywords: () => readonly string[];
    readonly requires?: FeatureRequirement;
} & ({ readonly to: RoutePath; readonly run?: never } | { readonly run: () => void; readonly to?: never });

export interface Attention {
    readonly count: number;
    readonly to: RoutePath;
}

export type AgentLiveState = 'idle' | 'working' | 'waiting' | 'failed';

/**
 * A feature describes itself once; the shell, the agent detail, the command palette (U-08) and the activity feed read
 * these descriptions instead of knowing features by name (ADR 0015, ADR 0016).
 */
export interface FeatureDefinition {
    readonly id: string;
    readonly requires: FeatureRequirement;
    readonly nav?: NavEntry;
    readonly agentTabs?: readonly AgentTabEntry[];
    readonly agentOverviewCards?: readonly AgentOverviewCardEntry[];
    readonly commands?: readonly CommandEntry[];
    readonly attention?: { readonly id: string; readonly useAttention: () => Attention };
    readonly liveIndicator?: { readonly useActiveCount: () => number };
    readonly agentStatusProvider?: { readonly useAgentLiveState: (agentId: AgentId) => AgentLiveState | null };
}

/** Identity at runtime; gives each feature file a typed, checked description. */
export function defineFeature<const Definition extends FeatureDefinition>(definition: Definition): Definition {
    return definition;
}
