import { screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Anchor } from './anchor';

describe('Anchor', () => {
    it.each(['light', 'dark'] as const)('is a named, focusable link (%s)', async (theme) => {
        const onClick = vi.fn((event: { preventDefault: () => void }) => {
            event.preventDefault();
        });
        const { container, user } = renderUi(
            <Anchor href="/agents" onClick={onClick}>
                {'Agents'}
            </Anchor>,
            { theme },
        );
        const link = screen.getByRole('link', { name: 'Agents' });
        expect(link.getAttribute('href')).toBe('/agents');
        await user.tab();
        expect(document.activeElement).toBe(link);
        await user.keyboard('{Enter}');
        expect(onClick).toHaveBeenCalledOnce();
        await expectNoAxeViolations(container);
    });

    it('passes through every prop a router link sets, including its ref', () => {
        const ref = createRef<HTMLAnchorElement>();
        renderUi(
            <Anchor ref={ref} href="/runs" variant="standalone" data-status="active" aria-current="page" className="x">
                {'Runs'}
            </Anchor>,
        );
        const link = screen.getByRole('link', { name: 'Runs' });
        expect(ref.current).toBe(link);
        expect(link.dataset['status']).toBe('active');
        expect(link.getAttribute('aria-current')).toBe('page');
        expect(link.className).toContain('x');
        expect(link.className).toContain('no-underline');
    });
});
