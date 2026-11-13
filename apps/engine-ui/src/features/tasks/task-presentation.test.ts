import { OCCURRENCE_REASONS, OCCURRENCE_STATES, TASK_STATES } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import {
    occurrenceReasonLabel,
    occurrenceStateLabel,
    occurrenceTone,
    TASK_STATUS_GROUP_IDS,
    TASK_STATUS_GROUPS,
    taskSection,
    taskStateLabel,
    taskStatusGroupLabel,
} from './task-state';
import { hasTaskFilters, selectedGroups, TaskSearch, taskListParams } from './task-search';

describe('task presentation', () => {
    it('labels every engine state, and an unknown one, and puts each in exactly one section', () => {
        const labels = [...TASK_STATES, 'unknown' as const].map((state) => taskStateLabel(state));
        expect(labels.every((label) => label.length > 0)).toBe(true);
        expect(new Set(TASK_STATES.map((state) => taskSection(state)))).toEqual(new Set(['now', 'upcoming', 'closed']));
        expect(taskSection('done')).toBe('closed');
        expect(taskSection('waiting-dependency')).toBe('upcoming');
        expect(taskSection('unknown')).toBe('now');
    });

    it('covers every engine state with exactly one status group', () => {
        const grouped = TASK_STATUS_GROUP_IDS.flatMap((group) => TASK_STATUS_GROUPS[group]);
        expect([...grouped].sort()).toEqual([...TASK_STATES].sort());
        expect(TASK_STATUS_GROUP_IDS.map((group) => taskStatusGroupLabel(group)).every(Boolean)).toBe(true);
    });

    it('labels every occurrence state and reason, and tones outcomes', () => {
        for (const state of [...OCCURRENCE_STATES, 'unknown' as const])
            expect(occurrenceStateLabel(state)).not.toBe('');
        for (const reason of [...OCCURRENCE_REASONS, 'unknown' as const]) {
            expect(occurrenceReasonLabel(reason)).not.toBe('');
        }
        expect(occurrenceTone('completed')).toBe('done');
        expect(occurrenceTone('interrupted')).toBe('trouble');
        expect(occurrenceTone('running')).toBe('live');
        expect(occurrenceTone('pending')).toBe('quiet');
    });

    it('reads the URL leniently and sends the engine only what is set', () => {
        const search = TaskSearch.parse({
            status: 'done,bogus,blocked',
            kind: 'system',
            q: '  ',
            agentId: 'not valid!',
        });
        expect(search).toEqual({ status: 'blocked,done' });
        expect(selectedGroups(search)).toEqual(['blocked', 'done']);
        expect(hasTaskFilters(search)).toBe(true);
        expect(TaskSearch.parse({ status: 'bogus' }).status).toBeUndefined();
        expect(hasTaskFilters(TaskSearch.parse({}))).toBe(false);
        expect(hasTaskFilters(TaskSearch.parse({ q: 'x' }))).toBe(true);
        expect(hasTaskFilters(TaskSearch.parse({ kind: 'engine' }))).toBe(true);
        expect(hasTaskFilters(TaskSearch.parse({ agentId: 'agent-ada' }))).toBe(true);
        expect(taskListParams(TaskSearch.parse({}))).toEqual({ limit: 50 });
        expect(
            taskListParams(
                TaskSearch.parse({ status: 'done,waiting', q: 'report', agentId: 'agent-ada', kind: 'engine' }),
            ),
        ).toEqual({
            limit: 50,
            state: 'waiting-until,waiting-dependency,not-ready,placeholder,done',
            q: 'report',
            agentId: 'agent-ada',
            kind: 'engine',
        });
    });
});
