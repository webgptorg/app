import type { ReadChat, ReadRun, ReadTask } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { NO_ACTIVITY } from './agent-activity';
import type { AgentActivity } from './agent-activity';
import { agentStatus, workingSince, workSummary } from './agent-status';

const runningTask = { id: 'task-ship', agentId: 'agent-ada', state: 'running' } as unknown as ReadTask;
const looseRun = {
    id: 'run-1',
    agentId: 'agent-max',
    taskId: null,
    chatId: null,
    startedAt: '2026-11-16T10:00:00.000Z',
} as unknown as ReadRun;
const chat = { id: 'chat-1' } as unknown as ReadChat;
const reply = {
    chat,
    working: { startedAt: '2026-11-16T09:59:00.000Z', messageId: null, author: { kind: 'agent', key: 'x' }, steps: [] },
} as unknown as AgentActivity['working'][number];

const withTask: AgentActivity = { ...NO_ACTIVITY, tasks: [runningTask] };
const state = (value: string) => ({ kind: 'state', state: value }) as const;

describe('agentStatus', () => {
    it('reads Ada, with a queued run and a running task, as working: running work wins over queued work', () => {
        expect(agentStatus(state('waiting'), withTask)).toMatchObject({ kind: 'working', label: 'Working' });
        expect(workSummary(withTask)).toBe('1 task');
    });

    it('is working when the run state says so, even with nothing in the page’s lists', () => {
        expect(agentStatus(state('working'), NO_ACTIVITY)?.kind).toBe('working');
        expect(agentStatus(state('running'), NO_ACTIVITY)?.kind).toBe('working');
    });

    it('keeps stopped and failed from the run state, then waiting, then idle', () => {
        expect(agentStatus(state('stopped'), NO_ACTIVITY)).toMatchObject({ kind: 'stopped', tone: 'warning' });
        expect(agentStatus(state('failed'), NO_ACTIVITY)).toMatchObject({ kind: 'failed', tone: 'danger' });
        expect(agentStatus(state('error'), NO_ACTIVITY)).toMatchObject({ kind: 'failed', label: 'Error' });
        expect(agentStatus(state('waiting'), NO_ACTIVITY)).toMatchObject({ kind: 'waiting', tone: 'waiting' });
        expect(agentStatus(state('idle'), NO_ACTIVITY)).toMatchObject({ kind: 'idle', tone: 'neutral' });
    });

    it('says working at once while the run state loads, and waits instead of flashing Idle otherwise', () => {
        expect(agentStatus({ kind: 'pending' }, withTask)?.kind).toBe('working');
        expect(agentStatus({ kind: 'pending' }, NO_ACTIVITY)).toBeNull();
    });

    it('shows a state from a newer engine as unknown with its raw value, and an unreadable one as unknown', () => {
        expect(agentStatus(state('dreaming'), NO_ACTIVITY)).toMatchObject({
            kind: 'unknown',
            label: 'Unknown (dreaming)',
        });
        expect(agentStatus({ kind: 'unavailable' }, NO_ACTIVITY)?.kind).toBe('unknown');
    });
});

describe('workingSince', () => {
    it('is the earliest start of a reply or run in view', () => {
        expect(workingSince({ ...NO_ACTIVITY, working: [reply], runs: [looseRun] })).toBe('2026-11-16T09:59:00.000Z');
        expect(workingSince(NO_ACTIVITY)).toBeNull();
    });
});
