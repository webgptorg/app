import type { EngineId } from '@ptbk/protocol';

import type { OrgId } from '../ids';
import type { UsageDay } from './usage-day';
import type { UsageEventRow } from './usage-event';
import type { EngineDay } from './engine-activity';

export interface ActiveEngine {
    readonly engineId: EngineId;
    readonly orgId: OrgId;
}

/** `usage_events` and the daily rollups (ADR 0022). Writes are idempotent per row, so a repeated run changes nothing. */
export interface UsageStore {
    insertEvents(rows: readonly UsageEventRow[]): Promise<void>;
    /** Engines that may heartbeat: active ones, of every organization. */
    listActiveEngines(): Promise<readonly ActiveEngine[]>;
    /** Writes each engine's day as given, replacing an earlier write of the same day. */
    upsertEngineDays(rows: readonly (EngineDay & ActiveEngine)[]): Promise<void>;
    /** Adds a row for everyone whose session was last used within `day`, in the session's organization. */
    rollUpPeople(day: UsageDay): Promise<void>;
    /** Deletes events that occurred before `eventsBefore` and rollup rows of days before `daysBefore`. */
    prune(cutoffs: { readonly eventsBefore: number; readonly daysBefore: UsageDay }): Promise<void>;
}
