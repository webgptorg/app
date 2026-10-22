import { describe, expect, it } from 'vitest';

import { BriefSchema } from './brief-step';
import { bookTemplate } from './book-template';

describe('bookTemplate', () => {
    it('names the agent on the first line and makes the description its persona, on one line each', () => {
        expect(bookTemplate({ name: '  Iris\nBot ', description: 'Writes\n\nthe report ' })).toBe(
            'Iris Bot\n\nPERSONA Writes the report\n',
        );
    });

    it('leaves the persona out when there is no description', () => {
        expect(bookTemplate({ name: 'Iris', description: '  ' })).toBe('Iris\n');
    });
});

describe('the brief schema', () => {
    it('refuses a missing name and over-long values with translated messages', () => {
        const result = BriefSchema.safeParse({ name: 'x'.repeat(257), description: 'y'.repeat(4097) });
        expect(result.error?.issues.map((issue) => issue.message)).toEqual([
            'The name can be at most 256 characters.',
            'The description can be at most 4096 characters.',
        ]);
        expect(BriefSchema.safeParse({ name: '  ', description: '' }).error?.issues[0]?.message).toBe(
            'Give the agent a name.',
        );
    });
});
