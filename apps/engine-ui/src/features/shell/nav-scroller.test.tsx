import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NavScroller } from './nav-scroller';

function scrollTo(element: HTMLElement, scrollTop: number) {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 400 });
    element.scrollTop = scrollTop;
    fireEvent.scroll(element);
}

describe('NavScroller', () => {
    it('marks the edges that have more items behind them', () => {
        const { container } = render(
            <NavScroller>
                <ul />
            </NavScroller>,
        );
        const scroller = container.firstElementChild as HTMLElement;
        expect(scroller.dataset['navScroller']).toBe('none');

        scrollTo(scroller, 0);
        expect(scroller.dataset['navScroller']).toBe('end');
        scrollTo(scroller, 100);
        expect(scroller.dataset['navScroller']).toBe('both');
        scrollTo(scroller, 199);
        expect(scroller.dataset['navScroller']).toBe('start');
    });
});
