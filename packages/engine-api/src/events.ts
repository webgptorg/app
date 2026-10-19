import { z } from 'zod';

import { AgentRunState } from './agents';
import { AgentId, ChatId, Timestamp } from './common';
import { defineRoute } from './route';

/** Change notifications, so the UI refreshes lists without polling. They carry IDs, never content. */
export const EngineEvent = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('agent.status'), agentId: AgentId, state: AgentRunState, since: Timestamp }),
    z.strictObject({ type: z.literal('agent.changed'), agentId: AgentId }),
    z.strictObject({ type: z.literal('chat.changed'), chatId: ChatId }),
]);
export type EngineEvent = z.infer<typeof EngineEvent>;

export const EVENT_ROUTES = {
    streamEvents: defineRoute({
        id: 'streamEvents',
        method: 'GET',
        path: '/events',
        summary:
            "Server-sent engine events, filtered by the member's permissions; every event has an SSE id and the stream resumes after `Last-Event-ID`",
        permission: 'agents.read',
        responses: { 200: { kind: 'sse', event: EngineEvent } },
    }),
} as const;
