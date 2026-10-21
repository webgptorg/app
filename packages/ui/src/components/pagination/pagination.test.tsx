import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Pagination } from './pagination';

describe('Pagination', () => {
    it.each(['light', 'dark'] as const)(
        'is a named nav with keyboard-operable previous and next (%s)',
        async (theme) => {
            const onPrevious = vi.fn();
            const onNext = vi.fn();
            const { container, user } = renderUi(
                <Pagination hasPrevious hasNext onPrevious={onPrevious} onNext={onNext} total={120} />,
                { theme },
            );
            const nav = screen.getByRole('navigation', { name: 'Pagination' });
            expect(nav.textContent).toContain('120 items');
            await user.tab();
            expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous page' }));
            await user.keyboard('{Enter}');
            await user.tab();
            await user.keyboard('{Enter}');
            expect(onPrevious).toHaveBeenCalledOnce();
            expect(onNext).toHaveBeenCalledOnce();
            await expectNoAxeViolations(container);
        },
    );

    it('disables the ends and everything while disabled', () => {
        const { rerender } = renderUi(<Pagination hasPrevious={false} hasNext onPrevious={vi.fn()} onNext={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(true);
        expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(false);
        rerender(<Pagination hasPrevious hasNext onPrevious={vi.fn()} onNext={vi.fn()} disabled />);
        expect(screen.queryAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(true);
    });

    it('reports hover and focus on each button as an intent', async () => {
        const onPreviousIntent = vi.fn();
        const onNextIntent = vi.fn();
        const { user } = renderUi(
            <Pagination
                hasPrevious
                hasNext
                onPrevious={vi.fn()}
                onNext={vi.fn()}
                onPreviousIntent={onPreviousIntent}
                onNextIntent={onNextIntent}
            />,
        );
        await user.hover(screen.getByRole('button', { name: 'Next page' }));
        expect(onNextIntent).toHaveBeenCalled();
        await user.tab();
        expect(onPreviousIntent).toHaveBeenCalledOnce();
    });
});
