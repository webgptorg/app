import type { ReadChatEntry } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { chatPreview } from './chat-preview';

const message = (content: string, fields: Record<string, unknown> = {}) =>
    ({ type: 'message', content, status: 'completed', phase: null, ...fields }) as unknown as ReadChatEntry;

describe('chatPreview', () => {
    it('never shows an agent’s steps: they read as working', () => {
        expect(
            chatPreview(
                { preview: '- thinking: The refunds are in the mailbox. - mcp__mail__search label:refund' },
                undefined,
            ),
        ).toEqual({ kind: 'working' });
    });

    it('prefers the newest real message from the cached thread, skipping progress and flattened steps', () => {
        const entries = [
            message('progress text', { phase: 'progress' }),
            message('- thinking: look\n- mcp__mail__search refund'),
            message('Still streaming', { status: 'streaming' }),
            message('Which refunds did we **approve**?'),
        ];
        expect(chatPreview({ preview: '- thinking: x - mcp__mail__search y' }, entries)).toEqual({
            kind: 'text',
            text: 'Which refunds did we approve?',
        });
    });

    it('keeps an ordinary preview, cleaned, and has nothing to say without one', () => {
        expect(chatPreview({ preview: '+@User Which {Ship it} first?' }, [])).toEqual({
            kind: 'text',
            text: 'Which Ship it first?',
        });
        expect(chatPreview({ preview: '- Read the brief first' }, undefined)).toEqual({
            kind: 'text',
            text: 'Read the brief first',
        });
        expect(chatPreview({ preview: null }, undefined)).toBeNull();
    });
});
