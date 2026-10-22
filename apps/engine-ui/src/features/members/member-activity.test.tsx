import type { Activity } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { engineActivitySummary } from '../security/engine-activity';
import { memberActivitySummary } from './member-activity';

const base = {
    v: 1,
    id: 'activity-1',
    at: '2026-10-01T12:00:00.000Z',
    agentId: null,
    agentName: null,
    actor: { kind: 'system' },
};
const member = { memberId: 'member-jana', displayName: '<img src=x>' };
const activity = (fields: Record<string, unknown>) => ({ ...base, ...fields }) as unknown as Activity;

describe('member and engine activity summaries', () => {
    it.each([
        [{ kind: 'member.joined', ...member }, '<img src=x> joined'],
        [
            { kind: 'member.role-changed', ...member, role: 'admin', previousRole: 'member' },
            '<img src=x> changed from Member to Admin',
        ],
        [{ kind: 'member.removed', ...member }, '<img src=x> was removed'],
        [{ kind: 'engine.update-available', version: '2.0.0' }, 'Engine version 2.0.0 is available'],
        [
            { kind: 'engine.updated', fromVersion: '1.0.0', toVersion: '2.0.0' },
            'The engine was updated from 1.0.0 to 2.0.0',
        ],
        [
            { kind: 'engine.relay-disconnected', relay: 'relay-fsn.ptbk.example' },
            'The connection to relay relay-fsn.ptbk.example dropped',
        ],
    ])('summarises %o', (fields, line) => {
        const item = activity(fields);
        const summary = item.kind.startsWith('member.') ? memberActivitySummary(item) : engineActivitySummary(item);
        expect(summary).toBe(line);
    });

    it('answers another area with its raw kind', () => {
        const run = activity({ kind: 'run.started', runId: 'run-1', source: 'web' });
        expect(memberActivitySummary(run)).toBe('run.started');
        expect(engineActivitySummary(run)).toBe('run.started');
    });
});
