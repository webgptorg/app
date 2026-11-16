import type { AgentId, AgentListQuery, MemberId } from '@ptbk/engine-api';
import type { z } from 'zod';

export type AgentListParams = z.input<typeof AgentListQuery>;

/** Every agent query lives under `agents`, so a reconnect of the event stream can refresh them all at once. */
export const agentKeys = {
    all: ['agents'] as const,
    lists: () => [...agentKeys.all, 'list'] as const,
    list: (params: AgentListParams) => [...agentKeys.lists(), params] as const,
    details: () => [...agentKeys.all, 'detail'] as const,
    detail: (agentId: AgentId) => [...agentKeys.details(), agentId] as const,
    status: (agentId: AgentId) => [...agentKeys.all, 'status', agentId] as const,
    lastActivity: (agentId: AgentId) => [...agentKeys.all, 'last-activity', agentId] as const,
    latestRun: (agentId: AgentId) => [...agentKeys.all, 'latest-run', agentId] as const,
    creator: (memberId: MemberId) => [...agentKeys.all, 'creator', memberId] as const,
    folders: () => [...agentKeys.all, 'folders'] as const,
};
