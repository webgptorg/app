import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SoftBreaks, splitAfter } from './soft-breaks';

describe('splitAfter', () => {
    it('keeps each separator with the piece before it', () => {
        expect(splitAfter('application/json', '/')).toEqual(['application/', 'json']);
        expect(splitAfter('{"a":1,"b":2}', ',')).toEqual(['{"a":1,', '"b":2}']);
        expect(splitAfter('2001:db8::1', ':')).toEqual(['2001:', 'db8:', ':', '1']);
    });

    it('returns the text whole when there is nothing to break after', () => {
        expect(splitAfter('10.0.0.1', ':')).toEqual(['10.0.0.1']);
        expect(splitAfter('', ',')).toEqual(['']);
        expect(splitAfter('a,', ',')).toEqual(['a,']);
    });
});

describe('SoftBreaks', () => {
    it('adds break opportunities without changing the text', () => {
        const { container } = render(
            <p>
                <SoftBreaks text="text/csv" after="/" />
            </p>,
        );
        expect(container.textContent).toBe('text/csv');
        expect(container.querySelectorAll('wbr')).toHaveLength(1);
    });
});
