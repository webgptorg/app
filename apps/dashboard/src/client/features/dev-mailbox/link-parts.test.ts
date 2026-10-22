import { describe, expect, it } from 'vitest';

import { linkParts } from './link-parts';

const ORIGIN = 'https://app.ptbk.test:8444';

describe('linkParts', () => {
    it('turns links to the dashboard into links and keeps the text around them', () => {
        expect(linkParts(`Create your passkey: ${ORIGIN}/signup#abc\n\nThanks`, ORIGIN)).toEqual([
            { kind: 'text', text: 'Create your passkey: ' },
            { kind: 'link', href: `${ORIGIN}/signup#abc` },
            { kind: 'text', text: '\n\nThanks' },
        ]);
    });

    it('leaves URLs on any other origin as text', () => {
        const text = 'See https://evil.test/x or http://app.ptbk.test:8444/plain or https://app.ptbk.test/other-port';
        expect(linkParts(text, ORIGIN)).toEqual([{ kind: 'text', text }]);
    });

    it('handles text without links, an empty text and adjacent links', () => {
        expect(linkParts('no links', ORIGIN)).toEqual([{ kind: 'text', text: 'no links' }]);
        expect(linkParts('', ORIGIN)).toEqual([]);
        expect(linkParts(`${ORIGIN}/a ${ORIGIN}/b`, ORIGIN)).toEqual([
            { kind: 'link', href: `${ORIGIN}/a` },
            { kind: 'text', text: ' ' },
            { kind: 'link', href: `${ORIGIN}/b` },
        ]);
    });
});
