import type { ActivityKindName } from '../activity';

export const AT = '2026-10-20T08:00:00Z';

const run = { runId: 'run-1', source: 'web' };
const file = { fileId: 'file-1', name: 'notes.txt' };
const trigger = { triggerId: 'trigger-1', name: 'Daily digest' };
const integration = { integrationId: 'integration-1', name: 'GitHub' };
const member = { memberId: 'member-2', displayName: 'Bob' };
const usage = { inputTokens: 1200, outputTokens: 300, durationMs: 4200, cost: { amount: '0.0123', currency: 'USD' } };
const error = { code: 'runner-crashed', summary: 'The runner exited with code 1.' };

/** One valid payload per known activity kind, without the common base fields. */
export const ACTIVITY_PAYLOADS: Readonly<Record<ActivityKindName, Readonly<Record<string, unknown>>>> = {
    'run.queued': run,
    'run.started': run,
    'run.completed': { ...run, usage },
    'run.failed': { ...run, error },
    'run.cancelled': run,
    'file.created': { ...file, purpose: 'knowledge' },
    'file.deleted': file,
    'file.scan-failed': file,
    'trigger.fired': { ...trigger, runId: 'run-1' },
    'trigger.failed': { ...trigger, error },
    'trigger.paused': trigger,
    'trigger.resumed': trigger,
    'integration.connected': integration,
    'integration.error': { ...integration, statusDetail: 'Token expired.' },
    'integration.used': { ...integration, toolName: 'create_issue', runId: null },
    'member.joined': member,
    'member.role-changed': { ...member, role: 'admin', previousRole: 'member' },
    'member.removed': member,
    'engine.update-available': { version: '1.9.0' },
    'engine.updated': { fromVersion: '1.8.2', toVersion: '1.9.0' },
    'engine.relay-disconnected': { relay: 'relay-fsn.ptbk.example' },
};

export function activitySample(kind: ActivityKindName, id = 'activity-1'): Record<string, unknown> {
    return {
        kind,
        v: 1,
        id,
        at: AT,
        agentId: 'agent-1',
        actor: { kind: 'member', memberId: 'member-1' },
        ...ACTIVITY_PAYLOADS[kind],
    };
}
