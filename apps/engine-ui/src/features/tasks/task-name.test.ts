import { describe, expect, it } from 'vitest';

import { splitTaskName } from './task-name';

describe('splitTaskName', () => {
    it("separates Reborn's instance stamp from the readable name", () => {
        expect(splitTaskName('Ship billing v2 — 2026-10-30 09:00:00')).toEqual({
            readable: 'Ship billing v2',
            stamp: '2026-10-30 09:00',
        });
        expect(splitTaskName('Text webu — 2026-11-13 12:16:54')).toEqual({
            readable: 'Text webu',
            stamp: '2026-11-13 12:16:54',
        });
        expect(splitTaskName('Weekly report - 2026-10-01')).toEqual({ readable: 'Weekly report', stamp: '2026-10-01' });
    });

    it('leaves other names whole, including ones that are only a stamp', () => {
        expect(splitTaskName('Update Promptbook 0.119.0 → 0.120.0')).toEqual({
            readable: 'Update Promptbook 0.119.0 → 0.120.0',
            stamp: null,
        });
        expect(splitTaskName('— 2026-10-30 09:00:00').stamp).toBeNull();
        expect(splitTaskName('Release 2026-10-30').stamp).toBeNull();
    });
});
