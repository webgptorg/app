import type { AgentId, TriggerListQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type TriggerListParams = z.input<typeof TriggerListQuery>;

export const triggerKeys = {
    all: ['triggers'] as const,
    lists: () => [...triggerKeys.all, 'list'] as const,
    list: (params: TriggerListParams) => [...triggerKeys.lists(), params] as const,
    details: () => [...triggerKeys.all, 'detail'] as const,
    detail: (triggerId: string) => [...triggerKeys.details(), triggerId] as const,
    allFires: () => [...triggerKeys.all, 'fires'] as const,
    fires: (triggerId: string, cursor: string | null) => [...triggerKeys.allFires(), triggerId, cursor] as const,
    allStats: () => [...triggerKeys.all, 'stats'] as const,
    /** `null` is the whole engine. */
    stats: (agentId: AgentId | null) => [...triggerKeys.allStats(), agentId] as const,
};
