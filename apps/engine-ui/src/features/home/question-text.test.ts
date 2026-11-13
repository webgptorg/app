import { describe, expect, it } from 'vitest';

import { questionQuote } from './question-text';

describe('questionQuote', () => {
    it('quotes the paragraph that asks the User, without the mark or markdown', () => {
        const content = 'I looked at the project.\n\n+@User Co má **@Copywriter** napsat?\nStačí pár vět:\n\n- web';
        expect(questionQuote(content)).toBe('Co má @Copywriter napsat? Stačí pár vět:');
    });

    it('falls back to the first paragraph and keeps long text short', () => {
        expect(questionQuote('  Which one?  \n\nMore')).toBe('Which one?');
        const quote = questionQuote(`+@User ${'word '.repeat(100)}`);
        expect(quote.length).toBeLessThanOrEqual(240);
        expect(quote.endsWith('…')).toBe(true);
    });

    it('keeps hostile text as plain characters for a text node', () => {
        expect(questionQuote('+@User <img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
        expect(questionQuote('')).toBe('');
    });
});
