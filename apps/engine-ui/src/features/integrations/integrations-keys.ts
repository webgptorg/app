import type { AgentId, IntegrationListQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type IntegrationListParams = z.input<typeof IntegrationListQuery>;

export const integrationKeys = {
    all: ['integrations'] as const,
    lists: () => [...integrationKeys.all, 'list'] as const,
    list: (params: IntegrationListParams) => [...integrationKeys.lists(), params] as const,
    details: () => [...integrationKeys.all, 'detail'] as const,
    detail: (integrationId: string) => [...integrationKeys.details(), integrationId] as const,
    allStats: () => [...integrationKeys.all, 'stats'] as const,
    /** `null` is the whole engine. */
    stats: (agentId: AgentId | null) => [...integrationKeys.allStats(), agentId] as const,
    activities: () => [...integrationKeys.all, 'activity'] as const,
    activity: (integrationId: string) => [...integrationKeys.activities(), integrationId] as const,
};
