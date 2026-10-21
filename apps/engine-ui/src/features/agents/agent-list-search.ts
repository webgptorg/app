import { AGENT_SORTS, AgentRunState, AgentVisibility } from '@ptbk/engine-api';
import { z } from 'zod';

import type { AgentListParams } from './agents-keys';

export const DEFAULT_AGENT_SORT = '-updatedAt';

/**
 * The list's state in the URL. Not strict: a URL may carry parameters this route does not know, and a bad value
 * falls back to the default instead of throwing. Cursors are opaque but always URL-safe base64 from the engine.
 */
export const AgentListSearch = z.object({
    q: z.string().trim().min(1).max(256).optional().catch(undefined),
    status: AgentRunState.optional().catch(undefined),
    visibility: AgentVisibility.optional().catch(undefined),
    sort: z.enum(AGENT_SORTS).default(DEFAULT_AGENT_SORT).catch(DEFAULT_AGENT_SORT),
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
});
export type AgentListSearch = z.output<typeof AgentListSearch>;

/** Everything goes to the engine; the UI never sorts or filters agents itself. */
export function agentListParams(search: AgentListSearch): AgentListParams {
    return {
        sort: search.sort,
        ...(search.q === undefined ? {} : { q: search.q }),
        ...(search.status === undefined ? {} : { status: search.status }),
        ...(search.visibility === undefined ? {} : { visibility: search.visibility }),
        ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    };
}
