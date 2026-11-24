import { activityCapability, activityPermission } from '../capabilities/activity';
import type { Activity } from '../capabilities/activity';
import type { CapabilityRef } from '../capabilities/capability';
import type { EngineEvent } from '../events';
import type { Permission } from '../permissions';
import { activityAgentName, advertises, page, sortBy, time, within } from './kit';
import type { Handlers } from './kit';

/**
 * Whether a member may see an activity item. The in-memory engine has no per-agent access rules, so every agent is
 * readable to anyone holding `agents.read` (the route's permission); the area's own read permission decides the rest.
 */
export function canSeeActivity(permissions: ReadonlySet<Permission>, activity: Activity): boolean {
    const permission = activityPermission(activity.kind);
    return permission !== null && permissions.has(permission);
}

const EVENT_PERMISSION: Record<Exclude<EngineEvent['type'], 'activity'>, Permission> = {
    'agent.status': 'agents.read',
    'agent.changed': 'agents.read',
    'chat.changed': 'chats.read',
    'run.changed': 'runs.read',
    'task.changed': 'tasks.read',
    'trigger.changed': 'triggers.read',
    'file.changed': 'files.read',
    'integration.changed': 'integrations.read',
    // IDs only: a watcher who may not see the tab's work gets 404 when reading it.
    'browser-tab.changed': 'browser.watch',
    'browser-help.changed': 'browser.watch',
    'ai-tool.changed': 'ai-tools.read',
};

export function canSeeEvent(permissions: ReadonlySet<Permission>, event: EngineEvent): boolean {
    return event.type === 'activity'
        ? canSeeActivity(permissions, event.activity)
        : permissions.has(EVENT_PERMISSION[event.type]);
}

function references(activity: Activity, field: 'runId' | 'triggerId' | 'integrationId', id: string): boolean {
    return field in activity && (activity as Readonly<Record<string, unknown>>)[field] === id;
}

export const ACTIVITY_HANDLERS: Pick<Handlers, 'listActivity'> = {
    listActivity: ({ query }, ctx) => {
        const kind = query.kind;
        const isAdvertised = (capability: CapabilityRef | null) => capability === null || advertises(ctx, capability);
        const items = ctx.state.activity.filter(
            (activity) =>
                canSeeActivity(ctx.permissions, activity) &&
                isAdvertised(activityCapability(activity.kind)) &&
                (query.agentId === undefined || activity.agentId === query.agentId) &&
                (kind === undefined ||
                    (kind.endsWith('.') ? activity.kind.startsWith(kind) : activity.kind === kind)) &&
                (query.runId === undefined || references(activity, 'runId', query.runId)) &&
                (query.triggerId === undefined || references(activity, 'triggerId', query.triggerId)) &&
                (query.integrationId === undefined || references(activity, 'integrationId', query.integrationId)) &&
                within(activity.at, query.from, query.to),
        );
        return page(
            items.map((activity) => ({ ...activity, agentName: activityAgentName(ctx, activity.agentId) })),
            sortBy('-at', (activity) => time(activity.at), true),
            query,
        );
    },
};
