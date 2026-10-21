import { AuditAction, AuditOutcome, AuditTargetKind, DEFAULT_PAGE_LIMIT, MemberId, OpaqueId } from '@ptbk/engine-api';
import { z } from 'zod';

import { CalendarDay, dayRange } from '../../app/day-range';
import type { AuditListParams } from './audit-keys';

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
    from: CalendarDay.optional().catch(undefined),
    to: CalendarDay.optional().catch(undefined),
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

/**
 * The engine's query: `from` is the start of that local day (inclusive) and `to` the start of the day after (the
 * engine's `to` is exclusive), so both days the reader picked are included whole.
 */
export function auditListParams(search: AuditSearch): AuditListParams {
    const { from, to } = dayRange(search.from, search.to);
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
