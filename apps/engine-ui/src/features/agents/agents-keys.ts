import type { AgentListQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type AgentListParams = z.input<typeof AgentListQuery>;

export const agentsKeys = {
    all: ['agents'] as const,
    lists: () => [...agentsKeys.all, 'list'] as const,
    list: (params: AgentListParams) => [...agentsKeys.lists(), params] as const,
};
