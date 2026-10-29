import { AgentId, DEFAULT_PAGE_LIMIT, RUN_STATUSES, RunSource, RunStatus } from '@ptbk/engine-api';
import type { RunStatus as RunStatusValue } from '@ptbk/engine-api';
import { z } from 'zod';

import { CalendarDay, dayRange } from '../../app/day-range';
import type { RunListParams } from './runs-keys';

/** A set of statuses as the URL and the engine write it, `failed` or `queued,running`; in the canonical order. */
const StatusSet = z
    .string()
    .max(128)
    .transform((value, ctx) => {
        const parts = new Set(value.split(','));
        for (const part of parts) {
            if (!RunStatus.safeParse(part).success) {
                ctx.addIssue({ code: 'custom', message: 'Unknown run status.' });
                return z.NEVER;
            }
        }
        return RUN_STATUSES.filter((status) => parts.has(status)).join(',');
    })
    .refine((value) => value !== '');

/**
 * The runs table's state in the URL, so a filtered page can be linked and survives a reload. A bad value falls back
 * to "no filter" instead of throwing; cursors are opaque but always URL-safe base64 from the engine.
 */
export const RunSearch = z.object({
    agentId: AgentId.optional().catch(undefined),
    status: StatusSet.optional().catch(undefined),
    source: RunSource.optional().catch(undefined),
    from: CalendarDay.optional().catch(undefined),
    to: CalendarDay.optional().catch(undefined),
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
});
export type RunSearch = z.output<typeof RunSearch>;

export const RUN_FILTER_KEYS = ['agentId', 'status', 'source', 'from', 'to'] as const;

export function hasRunFilters(search: RunSearch, scope: 'global' | 'agent'): boolean {
    return RUN_FILTER_KEYS.some((key) => (scope === 'agent' && key === 'agentId' ? false : search[key] !== undefined));
}

export function selectedStatuses(search: RunSearch): ReadonlySet<RunStatusValue> {
    const parts = search.status?.split(',') ?? [];
    return new Set(RUN_STATUSES.filter((status) => parts.includes(status)));
}

/** The engine's query; on an agent's tab the agent comes from the path, never from the search. */
export function runListParams(search: RunSearch, agentId?: AgentId): RunListParams {
    const scopedAgent = agentId ?? search.agentId;
    return {
        limit: DEFAULT_PAGE_LIMIT,
        ...(scopedAgent === undefined ? {} : { agentId: scopedAgent }),
        ...(search.status === undefined ? {} : { status: search.status }),
        ...(search.source === undefined ? {} : { source: search.source }),
        ...dayRange(search.from, search.to),
        ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    };
}

/** Where a run was opened from, so its back link returns there; anything else means the global list. */
export const RunDetailSearch = z.object({
    from: z.literal('agent').optional().catch(undefined),
});
export type RunDetailSearch = z.output<typeof RunDetailSearch>;
