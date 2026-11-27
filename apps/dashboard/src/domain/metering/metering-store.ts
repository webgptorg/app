import type { MeterId, MeterScope } from '../../shared/metering';
import type { OrgId } from '../ids';
import type { UsageDay } from '../usage/usage-day';
import type { OrgUsageFacts } from './usage-facts';

/** One meter's reading for one scope on one UTC day; the store keeps the day's peak beside the latest value. */
export interface MeterDayRow {
    readonly day: UsageDay;
    readonly orgId: OrgId;
    readonly scope: MeterScope;
    /** The organization's, team's or engine's ID. */
    readonly scopeId: string;
    readonly meter: MeterId;
    readonly value: number;
    readonly unreported: number;
}

export interface StoredMeterDay extends MeterDayRow {
    /** The day's highest `value` so far. */
    readonly peak: number;
}

/** What meters count, and their daily history (`usage_daily_meters`, ADR 0025). Every read is scoped or unscoped by name. */
export interface MeteringStore {
    readOrgFacts(orgId: OrgId): Promise<OrgUsageFacts>;
    /** Facts of every organization with an active project or a live team, for the daily history. */
    readMeteredFacts(): Promise<readonly OrgUsageFacts[]>;
    /** Replaces each row's value and raises its peak; a repeated write of the same reading changes nothing. */
    upsertMeterDays(rows: readonly MeterDayRow[]): Promise<void>;
    /** One organization's rows from `from` on, oldest first. */
    listMeterDays(orgId: OrgId, from: UsageDay): Promise<readonly StoredMeterDay[]>;
    pruneMeterDays(before: UsageDay): Promise<void>;
}
