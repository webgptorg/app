import { describe, expect, it } from 'vitest';

import { areaOf } from './activity/activity-areas';
import { dayPart, greeting } from './home-header';

describe('the greeting', () => {
    it.each([
        [0, 'evening'],
        [4, 'evening'],
        [5, 'morning'],
        [11, 'morning'],
        [12, 'afternoon'],
        [17, 'afternoon'],
        [18, 'evening'],
        [23, 'evening'],
    ] as const)('calls %i:00 %s', (hour, part) => {
        expect(dayPart(hour)).toBe(part);
    });

    it('greets by name for each part of the day, the name as given', () => {
        expect(greeting('<b>Ada</b>', 'morning')).toBe('Good morning, <b>Ada</b>');
        expect(greeting('Ada', 'afternoon')).toBe('Good afternoon, Ada');
        expect(greeting('Ada', 'evening')).toBe('Good evening, Ada');
    });
});

describe('activity areas', () => {
    it('is the part before the first dot, or none', () => {
        expect(areaOf('run.failed')).toBe('run');
        expect(areaOf('trigger.fired.late')).toBe('trigger');
        expect(areaOf('started')).toBeNull();
        expect(areaOf('.started')).toBeNull();
    });
});
