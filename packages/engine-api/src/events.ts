import { z } from 'zod';

import { AgentRunState } from './agents';
import { ActivityEvent, parseActivity } from './capabilities/activity';
import type { ActivityItem } from './capabilities/activity';
import { FileChangedEvent } from './capabilities/files';
import { IntegrationChangedEvent } from './capabilities/integrations';
import { RunChangedEvent, RunChangedEventReader } from './capabilities/runs';
import { TriggerChangedEvent } from './capabilities/triggers';
import { AgentId, ChatId, Timestamp } from './common';
import { defineRoute } from './route';
import { toTolerant } from './tolerant';

const coreEvents = [
    z.strictObject({ type: z.literal('agent.status'), agentId: AgentId, state: AgentRunState, since: Timestamp }),
    z.strictObject({ type: z.literal('agent.changed'), agentId: AgentId }),
    z.strictObject({ type: z.literal('chat.changed'), chatId: ChatId }),
    TriggerChangedEvent,
    FileChangedEvent,
    IntegrationChangedEvent,
] as const;
const CoreEngineEvent = z.discriminatedUnion('type', [...coreEvents, RunChangedEvent]);

/**
 * Change notifications, so the UI refreshes lists without polling. They carry IDs, never content, and the engine sends
 * each one only to members with the matching read permission.
 */
export const EngineEvent = z.discriminatedUnion('type', [...CoreEngineEvent.options, ActivityEvent]);
export type EngineEvent = z.infer<typeof EngineEvent>;

/** An event as the client reads it: activity goes through `parseActivity`, so an unknown kind is data, not an error. */
export type ReadEngineEvent =
    | Exclude<EngineEvent, { readonly type: 'activity' | 'run.changed' }>
    | z.output<typeof RunChangedEventReader>
    | { readonly type: 'activity'; readonly activity: ActivityItem };

const tolerantCoreEvent = toTolerant(z.discriminatedUnion('type', [...coreEvents, RunChangedEventReader]));
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(EngineEvent.options.map((option) => option.shape.type.value));

/** `null` for events the client skips: unknown types, and activity without a valid base. */
export const EngineEventReader = z.unknown().transform((raw, ctx): ReadEngineEvent | null => {
    const type =
        typeof raw === 'object' && raw !== null ? (raw as Readonly<Record<string, unknown>>)['type'] : undefined;
    if (typeof type !== 'string' || !KNOWN_EVENT_TYPES.has(type)) return null;
    if (type === 'activity') {
        const activity = parseActivity((raw as Readonly<Record<string, unknown>>)['activity']);
        return activity.kind === 'dropped' ? null : { type, activity };
    }
    const event = tolerantCoreEvent.safeParse(raw);
    if (event.success) return event.data;
    for (const issue of event.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    return z.NEVER;
});

export const EVENT_ROUTES = {
    streamEvents: defineRoute({
        id: 'streamEvents',
        method: 'GET',
        path: '/events',
        summary:
            "Server-sent engine events, filtered by the member's permissions; every event has an SSE id and the stream resumes after `Last-Event-ID`",
        description:
            'Clients ignore event types they do not know, so engines may add types within a version. The engine keeps a bounded buffer of recent events: a `Last-Event-ID` that is unknown or no longer buffered resumes from the oldest buffered event. Event IDs keep increasing across dropped events and gaps are not signalled, so a client refetches what it shows on every reconnect.',
        permission: 'agents.read',
        responses: { 200: { kind: 'sse', event: EngineEvent, read: EngineEventReader } },
    }),
} as const;
