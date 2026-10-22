import { AgentId, DEFAULT_PAGE_LIMIT, TriggerKind, TriggerLifecycle } from '@ptbk/engine-api';
import { z } from 'zod';

import type { TriggerListParams } from './triggers-keys';

/**
 * The trigger list's filters and page in the URL, so a filtered view can be linked and survives a reload. A bad value
 * falls back to "no filter" instead of throwing; cursors are opaque but always URL-safe base64 from the engine.
 */
export const TriggerSearch = z.object({
    kind: TriggerKind.optional().catch(undefined),
    lifecycle: TriggerLifecycle.optional().catch(undefined),
    agentId: AgentId.optional().catch(undefined),
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
});
export type TriggerSearch = z.output<typeof TriggerSearch>;

export function hasTriggerFilters(search: TriggerSearch, scope: 'global' | 'agent'): boolean {
    return (
        search.kind !== undefined ||
        search.lifecycle !== undefined ||
        (scope === 'global' && search.agentId !== undefined)
    );
}

/** The engine's query; on an agent's tab the agent comes from the path, never from the search. */
export function triggerListParams(search: TriggerSearch, agentId?: AgentId): TriggerListParams {
    const scopedAgent = agentId ?? search.agentId;
    return {
        limit: DEFAULT_PAGE_LIMIT,
        ...(scopedAgent === undefined ? {} : { agentId: scopedAgent }),
        ...(search.kind === undefined ? {} : { kind: search.kind }),
        ...(search.lifecycle === undefined ? {} : { lifecycle: search.lifecycle }),
        ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    };
}
