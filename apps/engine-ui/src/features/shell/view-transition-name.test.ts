import { describe, expect, it } from 'vitest';

import { morphName, morphStyle } from './view-transition-name';

describe('morphName', () => {
    it('keeps plain IDs readable and the same on both ends', () => {
        expect(morphName('task', 'task-ship-billing')).toBe('task-title-task-ship-billing');
        expect(morphStyle('task', 'a1')).toEqual({ viewTransitionName: 'task-title-a1' });
    });

    it('escapes anything that could be CSS syntax, and keeps distinct IDs distinct', () => {
        const hostile = morphName('task', 'x) ; } body{color:red');
        expect(hostile).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(morphName('task', 'a_1')).not.toBe(morphName('task', 'a.1'));
        expect(morphName('task', '1')).toBe('task-title-1');
    });
});
