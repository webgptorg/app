import { AGENT_SORTS, AgentId, AgentRunState, AgentVisibility, DEFAULT_PAGE_LIMIT, FolderId } from '@ptbk/engine-api';
import { z } from 'zod';

import type { AgentListParams } from './agents-keys';
import { AGENT_VIEWS } from './agent-view';

export const DEFAULT_AGENT_SORT = '-updatedAt';

/** The member's own agents, or the engine's (core and system), which the list groups as "Built-in". */
export const AGENT_LIST_ORIGINS = ['own', 'built-in'] as const;
export type AgentListOrigin = (typeof AGENT_LIST_ORIGINS)[number];

/** Seven today (six core roles and Expert); room for a few more before the group would need paging. */
const BUILT_IN_LIMIT = DEFAULT_PAGE_LIMIT;

/**
 * The list's state in the URL. Not strict: a URL may carry parameters this route does not know, and a bad value
 * falls back to the default instead of throwing. Cursors are opaque but always URL-safe base64 from the engine.
 */
export const AgentListSearch = z.object({
    q: z.string().trim().min(1).max(256).optional().catch(undefined),
    status: AgentRunState.optional().catch(undefined),
    visibility: AgentVisibility.optional().catch(undefined),
    origin: z.enum(AGENT_LIST_ORIGINS).optional().catch(undefined),
    folderId: FolderId.optional().catch(undefined),
    sort: z.enum(AGENT_SORTS).default(DEFAULT_AGENT_SORT).catch(DEFAULT_AGENT_SORT),
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
    /** Cards or the table; without it, the member's last choice on this device. */
    view: z.enum(AGENT_VIEWS).optional().catch(undefined),
    /** The agent whose panel is open over the grid, so the open panel is a link. */
    agent: AgentId.optional().catch(undefined),
});
export type AgentListSearch = z.output<typeof AgentListSearch>;

export function hasAgentFilters(search: AgentListSearch): boolean {
    return (
        search.q !== undefined ||
        search.status !== undefined ||
        search.visibility !== undefined ||
        search.origin !== undefined ||
        search.folderId !== undefined
    );
}

function filterParams(search: AgentListSearch) {
    return {
        sort: search.sort,
        ...(search.q === undefined ? {} : { q: search.q }),
        ...(search.status === undefined ? {} : { status: search.status }),
        ...(search.visibility === undefined ? {} : { visibility: search.visibility }),
        ...(search.folderId === undefined ? {} : { folderId: search.folderId }),
    };
}

/** Everything goes to the engine; the UI never sorts or filters agents itself. The member's own agents page. */
export function agentListParams(search: AgentListSearch): AgentListParams {
    return {
        origin: 'content',
        ...filterParams(search),
        ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    };
}

/** The built-in group under them: the same filters and order, one short page. */
export function builtInAgentParams(search: AgentListSearch): AgentListParams {
    return { origin: 'core,system', ...filterParams(search), limit: BUILT_IN_LIMIT };
}

/** Which groups the table shows: built-in agents ride along on the first page only, since they are never paged. */
export function agentListGroups(search: AgentListSearch): { readonly own: boolean; readonly builtIn: boolean } {
    return {
        own: search.origin !== 'built-in',
        builtIn: search.origin !== 'own' && search.cursor === undefined,
    };
}

/** The part of the list's state the engine is asked about; the view and the open panel change no request. */
export function engineSearch(search: AgentListSearch): AgentListSearch {
    return { ...search, view: undefined, agent: undefined };
}
