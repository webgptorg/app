import { RUN_SOURCES } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { sourceLabel } from './chat-source';

describe('sourceLabel', () => {
    it('names every run source, and one this UI does not know as unknown', () => {
        expect(RUN_SOURCES.map(sourceLabel)).toEqual([
            'Web',
            'API',
            'Email',
            'Schedule',
            'Team member',
            'Goal',
            'Webhook',
        ]);
        expect(sourceLabel('unknown')).toBe('Unknown');
    });
});
