import { describe, expect, it } from 'vitest';

import { plainText, questionQuote } from './question-text';

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

    it('turns a preview into one calm line', () => {
        expect(plainText('Completed {Text webu — 2026-11-13}: done')).toBe('Completed Text webu — 2026-11-13: done');
        expect(plainText('- thinking: look - mcp__mail__search x')).toBe('thinking: look mcp__mail__search x');
        expect(plainText('+@User Should we?')).toBe('Should we?');
    });
});
