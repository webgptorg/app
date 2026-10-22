import type { EngineApiClient, MemberId, SemVer } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { agentListQueryOptions } from '../agents/agents-queries';
import { runListQueryOptions } from '../runs/runs-queries';
import { homeKeys } from './home-keys';
import type { RecentChatParams } from './home-keys';

export const RECENT_AGENTS = 6;
export const RECENT_CHATS = 5;

/** The control center's recent agents (`GET /agents?sort=-updatedAt&limit=6`). */
export function recentAgentsQueryOptions(engineApi: EngineApiClient) {
    return agentListQueryOptions(engineApi, { sort: '-updatedAt', limit: RECENT_AGENTS });
}

/** The agents a member can use, most recently changed first; the engine lists only those. */
export function memberAgentsQueryOptions(engineApi: EngineApiClient) {
    return agentListQueryOptions(engineApi, { sort: '-updatedAt' });
}

const RECENT_CHAT_PARAMS: RecentChatParams = { limit: RECENT_CHATS };

/** `GET /chats` across agents, most recently active first. */
export function recentChatsQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: homeKeys.recentChats(RECENT_CHAT_PARAMS),
        queryFn: async ({ signal }) => unwrap(await engineApi.chats.listAll(RECENT_CHAT_PARAMS, signal)),
        staleTime: 30_000,
    });
}

/** The member's own queued and running runs (`runs@1`); `run.changed` events keep the runs cache current. */
export function myRunsQueryOptions(engineApi: EngineApiClient, memberId: MemberId) {
    return runListQueryOptions(engineApi, { createdBy: memberId, status: 'queued,running' });
}

export interface UpdateNotice {
    readonly version: SemVer;
}

/** An `engine.update-available` seen on the event stream; there is nothing to fetch, the event sync writes it. */
export function updateNoticeQueryOptions() {
    return queryOptions({
        queryKey: homeKeys.updateNotice(),
        queryFn: (): UpdateNotice | null => null,
        staleTime: Number.POSITIVE_INFINITY,
    });
}
