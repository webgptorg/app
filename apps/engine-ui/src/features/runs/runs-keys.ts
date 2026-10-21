import type { AgentId, RunListQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type RunListParams = z.input<typeof RunListQuery>;

export const runKeys = {
    all: ['runs'] as const,
    lists: () => [...runKeys.all, 'list'] as const,
    list: (params: RunListParams) => [...runKeys.lists(), params] as const,
    details: () => [...runKeys.all, 'detail'] as const,
    detail: (runId: string) => [...runKeys.details(), runId] as const,
    allStats: () => [...runKeys.all, 'stats'] as const,
    /** `null` is the whole engine. */
    stats: (agentId: AgentId | null) => [...runKeys.allStats(), agentId] as const,
};
