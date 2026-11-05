import { describe, expect, it } from 'vitest';

import { EngineEventReader } from '../events';
import {
    Task,
    TaskDetail,
    TaskDetailReader,
    TaskListQuery,
    TaskOccurrence,
    TaskOccurrencePageReader,
    TaskPageReader,
    TaskReader,
} from './tasks';

const NOW = '2026-11-05T08:00:00Z';

const task = {
    id: 'task-send',
    name: 'Send the first issue — 2026-11-01 09:00:00',
    kind: 'ordinary',
    purpose: null,
    core: false,
    agentId: 'agent-ada',
    agentName: 'Ada',
    executor: null,
    priority: { rank: 2, text: 'high' },
    state: 'waiting-dependency',
    stateReason: 'Waits for Draft the first issue.',
    next: null,
    conditions: [{ kind: 'dependency', met: false, text: 'Draft the first issue is done' }],
    repeat: null,
    notBefore: null,
    dueAt: NOW,
    nextAt: null,
    progress: { completed: 1, total: 3, summary: 'Checking links' },
    parent: { taskId: 'task-launch', name: 'Launch the newsletter' },
    dependsOn: [{ taskId: 'task-draft', name: 'Draft the first issue', state: 'pending' }],
    origin: { kind: 'chat', chatId: 'chat-plan', taskId: null, text: 'Chat {Plan the newsletter}' },
    doneCount: 0,
    lastDoneAt: null,
    reopened: false,
    sourcePath: 'tasks/send-the-first-issue.book',
    allowedActions: [],
    updatedAt: NOW,
};

const detail = {
    ...task,
    children: [],
    blocks: [{ taskId: 'task-announce', name: 'Announce it', state: 'waiting-dependency' }],
    links: [{ direction: 'incoming', target: { type: 'chat', chatId: 'chat-plan', name: 'Plan the newsletter' } }],
    notes: [],
};

const occurrence = {
    id: 'occ-1',
    taskId: 'task-send',
    sequence: 1,
    cycle: 1,
    reason: 'first',
    retryOf: null,
    state: 'completed',
    scheduledFor: null,
    startedAt: NOW,
    endedAt: NOW,
    summary: 'Sent to 120 readers.',
    runIds: ['run-1'],
};

describe('tasks@1 schemas', () => {
    it('accepts a valid task, detail and occurrence and rejects unknown fields', () => {
        expect(Task.parse(task)).toEqual(task);
        expect(TaskDetail.parse(detail)).toEqual(detail);
        expect(TaskOccurrence.parse(occurrence)).toEqual(occurrence);
        expect(Task.safeParse({ ...task, extra: 1 }).success).toBe(false);
        expect(TaskDetail.safeParse({ ...detail, links: [{ ...detail.links[0], weight: 1 }] }).success).toBe(false);
    });

    it('refuses a state, action or kind this contract does not define, as an engine must not send one', () => {
        expect(Task.safeParse({ ...task, state: 'paused' }).success).toBe(false);
        expect(Task.safeParse({ ...task, allowedActions: ['delete'] }).success).toBe(false);
        expect(Task.safeParse({ ...task, kind: 'system' }).success).toBe(false);
        expect(Task.safeParse({ ...task, priority: { rank: -1, text: null } }).success).toBe(false);
        expect(Task.safeParse({ ...task, id: 'Send the first issue' }).success).toBe(false);
    });

    it('reads what a newer engine adds as unknown or drops it, so the list still loads', () => {
        const read = TaskReader.parse({
            ...task,
            state: 'paused',
            kind: 'hosted',
            purpose: 'hobby',
            allowedActions: ['cancel', 'delete'],
            conditions: [{ kind: 'weather', met: true, text: 'Sunny' }],
            dependsOn: [{ taskId: 'task-draft', name: 'Draft', state: 'skipped' }],
            origin: { ...task.origin, kind: 'email' },
            extra: true,
        });
        expect(read).toMatchObject({ state: 'unknown', kind: 'unknown', purpose: 'unknown' });
        expect(read.allowedActions).toEqual(['cancel']);
        expect(read.conditions[0]?.kind).toBe('unknown');
        expect(read.dependsOn[0]?.state).toBe('unknown');
        expect(read.origin?.kind).toBe('unknown');
        expect(read).not.toHaveProperty('extra');
        expect(TaskPageReader.parse({ items: [task], nextCursor: null }).items).toHaveLength(1);
    });

    it('drops a link of a type it does not know and reads unknown relation states as unknown', () => {
        const read = TaskDetailReader.parse({
            ...detail,
            children: [{ taskId: 'task-a', name: 'A', state: 'paused' }],
            links: [...detail.links, { direction: 'outgoing', target: { type: 'file', fileId: 'f', name: 'Plan.md' } }],
        });
        expect(read.links).toEqual(detail.links);
        expect(read.children[0]?.state).toBe('unknown');
        expect(read.blocks[0]?.state).toBe('waiting-dependency');
    });

    it('reads an occurrence state or reason a newer engine added as unknown', () => {
        const page = TaskOccurrencePageReader.parse({
            items: [{ ...occurrence, state: 'skipped', reason: 'manual' }],
            nextCursor: null,
        });
        expect(page.items[0]).toMatchObject({ state: 'unknown', reason: 'unknown' });
    });

    it('reads a state filter as a set and refuses an unknown state', () => {
        expect(TaskListQuery.parse({ state: 'done,ready,done' }).state).toEqual(['done', 'ready']);
        expect(TaskListQuery.safeParse({ state: 'done,paused' }).success).toBe(false);
        expect(TaskListQuery.safeParse({ q: '' }).success).toBe(false);
    });

    it('reads task.changed events, with an unknown state as unknown', () => {
        expect(EngineEventReader.parse({ type: 'task.changed', taskId: 'task-send', state: 'done' })).toEqual({
            type: 'task.changed',
            taskId: 'task-send',
            state: 'done',
        });
        expect(EngineEventReader.parse({ type: 'task.changed', taskId: 'task-send', state: 'paused' })).toMatchObject({
            state: 'unknown',
        });
    });
});
