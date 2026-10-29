import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUi } from '../../testing/render';
import { revealScrollLeft, scrollEdges } from '../../internal/scroll-edges';
import { Tabs } from './tabs';

describe('scrollEdges', () => {
    it('reports no hidden side when everything fits', () => {
        expect(scrollEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300, rtl: false })).toEqual({
            left: false,
            right: false,
        });
    });

    it('reports the sides that hide content, left to right', () => {
        const box = { scrollWidth: 600, clientWidth: 300, rtl: false };
        expect(scrollEdges({ ...box, scrollLeft: 0 })).toEqual({ left: false, right: true });
        expect(scrollEdges({ ...box, scrollLeft: 150 })).toEqual({ left: true, right: true });
        expect(scrollEdges({ ...box, scrollLeft: 299.5 })).toEqual({ left: true, right: false });
    });

    it('reads negative scroll positions right to left', () => {
        const box = { scrollWidth: 600, clientWidth: 300, rtl: true };
        expect(scrollEdges({ ...box, scrollLeft: 0 })).toEqual({ left: true, right: false });
        expect(scrollEdges({ ...box, scrollLeft: -300 })).toEqual({ left: false, right: true });
    });
});

describe('revealScrollLeft', () => {
    const view = { start: 100, width: 300 };

    it('leaves a visible item alone', () => {
        expect(revealScrollLeft(view, { start: 150, width: 80 })).toBeNull();
    });

    it('scrolls back to an item before the view and on to one after it', () => {
        expect(revealScrollLeft(view, { start: 40, width: 80 })).toBe(40);
        expect(revealScrollLeft(view, { start: 380, width: 80 })).toBe(160);
    });
});

describe('Tabs on a narrow screen', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('scrolls the selected tab into view and fades the side that hides tabs', () => {
        vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(600);
        vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(300);
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: Element) {
            const isTab = this.getAttribute('role') === 'tab';
            const left = isTab ? 500 : 0;
            const width = isTab ? 80 : 300;
            return { left, width, top: 0, height: 40, right: left + width, bottom: 40, x: left, y: 0 } as DOMRect;
        });
        renderUi(
            <Tabs
                label="Agent"
                selectedId="settings"
                onSelect={() => undefined}
                tabs={[
                    { id: 'overview', label: 'Overview', panel: null },
                    { id: 'settings', label: 'Settings', panel: <p>Settings panel</p> },
                ]}
                fill
            />,
        );
        const tablist = screen.getByRole('tablist', { name: 'Agent' });
        expect(tablist.scrollLeft).toBe(280);
        expect(tablist.className).toContain('mask-image');
        expect(screen.getByRole('tabpanel').className).toContain('flex-1');
    });
});
