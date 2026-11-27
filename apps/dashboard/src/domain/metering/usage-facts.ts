import type { EngineId } from '@ptbk/protocol';

import type { OrgId, TeamId } from '../ids';
import type { UsageDay } from '../usage/usage-day';

/** The engine's own counts from its last heartbeat the rollup saw (ADR 0022); trusted as reported. */
export interface HeartbeatCounts {
    readonly agents: number;
    readonly members: number;
    readonly day: UsageDay;
}

/** An active engine: revoked and suspended ones are no project of the organization's. */
export interface ProjectFacts {
    readonly engineId: EngineId;
    /** Null only between registration and binding (ADR 0018). */
    readonly teamId: TeamId | null;
    /** Null until the engine's first heartbeat reached a rollup. */
    readonly heartbeat: HeartbeatCounts | null;
}

/** A team that is not deleted, with how many people the dashboard added to it. */
export interface TeamFacts {
    readonly teamId: TeamId;
    readonly people: number;
}

/**
 * Everything a meter may count (ADR 0025): metadata the dashboard holds, never content from inside an engine. A meter
 * that needs more adds a field here and the store's query for it.
 */
export interface OrgUsageFacts {
    readonly orgId: OrgId;
    readonly projects: readonly ProjectFacts[];
    readonly teams: readonly TeamFacts[];
    /** The organization's members in the dashboard. */
    readonly people: number;
}
