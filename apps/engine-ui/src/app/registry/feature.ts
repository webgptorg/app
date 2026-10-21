import type { Activity, AgentId, CapabilityRef, Permission } from '@ptbk/engine-api';
import type { ComponentType } from 'react';

import type { FileRoutesByTo } from '../../routeTree.gen';

/** A route path as the router knows it, so renaming a route breaks every registry entry that names it. */
export type RoutePath = keyof FileRoutesByTo;

/** What a feature or one of its entries needs before the shell shows it. */
export interface FeatureRequirement {
    /** The engine must advertise exactly this capability version (`GET /engine`, ADR 0016). */
    readonly capability?: CapabilityRef;
    readonly permission?: Permission;
    /** At least one of these, for entries that serve several actions (e.g. an agent's Settings tab). */
    readonly anyPermission?: readonly Permission[];
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

/**
 * Agent detail tabs in the order of docs/design/ui.md. Features register their tab with this ID and order, so the
 * detail page needs no knowledge of them and its header can offer "Chat" and "Edit" when those tabs exist.
 */
export const AGENT_TABS = {
    overview: { id: 'overview', order: 10 },
    chat: { id: 'chat', order: 20 },
    runs: { id: 'runs', order: 30 },
    files: { id: 'files', order: 40 },
    triggers: { id: 'triggers', order: 50 },
    integrations: { id: 'integrations', order: 60 },
    book: { id: 'book', order: 70 },
    settings: { id: 'settings', order: 80 },
} as const;

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
    /** Search params for `to`, e.g. a status filter that shows exactly what needs attention. */
    readonly search?: Readonly<Record<string, string>>;
}

/**
 * Renders activity items of one area for the home feed (U-08). `kind` is exact (`run.failed`) or an area prefix
 * (`run.*`); an item whose kind or version no renderer claims gets the feed's generic card.
 */
export interface ActivityRendererEntry {
    readonly kind: string;
    readonly versions: readonly number[];
    readonly component: ComponentType<{ readonly activity: Activity }>;
    /** One line of plain text, for notifications and the command palette. */
    readonly summary: (activity: Activity) => string;
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
    readonly activityRenderers?: readonly ActivityRendererEntry[];
    /**
     * Keeps the feature's cached data current from the engine's event stream for as long as the shell is mounted, so
     * the shell's live indicator, agent statuses and other screens' cards stay true without polling. Called once.
     */
    readonly eventSync?: { readonly useEventSync: () => void };
}

/** Identity at runtime; gives each feature file a typed, checked description. */
export function defineFeature<const Definition extends FeatureDefinition>(definition: Definition): Definition {
    return definition;
}
