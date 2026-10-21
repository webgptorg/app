import { AuditAction, AuditOutcome, AuditTargetKind, DEFAULT_PAGE_LIMIT, MemberId, OpaqueId } from '@ptbk/engine-api';
import { z } from 'zod';

import type { AuditListParams } from './audit-keys';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateParts(value: string): readonly [number, number, number] | undefined {
    const match = DATE_PATTERN.exec(value);
    if (match === null) return undefined;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    // `2026-02-30` would otherwise roll over into March.
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? [year, month, day] : undefined;
}

/** A calendar day as a date input writes it, `YYYY-MM-DD`. */
export const AuditDate = z.string().refine((value) => dateParts(value) !== undefined);

// The router reads search values as JSON, so an all-digit ID arrives as a number.
const idParam = <Schema extends z.ZodType<string>>(schema: Schema) =>
    z.preprocess((value) => (typeof value === 'number' ? String(value) : value), schema);

/** The log's filters and page in the URL; a bad value falls back to "no filter" instead of throwing. */
export const AuditSearch = z.object({
    memberId: idParam(MemberId).optional().catch(undefined),
    action: AuditAction.optional().catch(undefined),
    targetKind: AuditTargetKind.optional().catch(undefined),
    targetId: idParam(OpaqueId).optional().catch(undefined),
    outcome: AuditOutcome.optional().catch(undefined),
    from: AuditDate.optional().catch(undefined),
    to: AuditDate.optional().catch(undefined),
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
});
export type AuditSearch = z.output<typeof AuditSearch>;

export const AUDIT_FILTER_KEYS = ['memberId', 'action', 'targetKind', 'targetId', 'outcome', 'from', 'to'] as const;

export function hasAuditFilters(search: AuditSearch): boolean {
    return AUDIT_FILTER_KEYS.some((key) => search[key] !== undefined);
}

/** Local midnight at the start of `date`, `days` later, as the UTC instant the engine filters by. */
function localDayStart(date: string, days: number): string | undefined {
    const parts = dateParts(date);
    if (parts === undefined) return undefined;
    const [year, month, day] = parts;
    return new Date(year, month - 1, day + days).toISOString();
}

/**
 * The engine's query: `from` is the start of that local day (inclusive) and `to` the start of the day after (the
 * engine's `to` is exclusive), so both days the reader picked are included whole.
 */
export function auditListParams(search: AuditSearch): AuditListParams {
    const from = search.from === undefined ? undefined : localDayStart(search.from, 0);
    const to = search.to === undefined ? undefined : localDayStart(search.to, 1);
    return {
        limit: DEFAULT_PAGE_LIMIT,
        ...(search.memberId === undefined ? {} : { memberId: search.memberId }),
        ...(search.action === undefined ? {} : { action: search.action }),
        ...(search.targetKind === undefined ? {} : { targetKind: search.targetKind }),
        ...(search.targetId === undefined ? {} : { targetId: search.targetId }),
        ...(search.outcome === undefined ? {} : { outcome: search.outcome }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    };
}
