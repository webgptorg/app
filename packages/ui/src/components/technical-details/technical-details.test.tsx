import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { TechnicalDetails } from './technical-details';

const HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

describe('TechnicalDetails', () => {
    it.each(['light', 'dark'] as const)(
        'is collapsed, opens from its summary and copies each value whole (%s)',
        async (theme) => {
            const copy = vi.fn(() => Promise.resolve());
            const { container, user } = renderUi(
                <TechnicalDetails
                    items={[
                        { label: 'SHA-256', value: HASH },
                        { label: 'Commit', value: 'a94a8fe' },
                    ]}
                    copy={copy}
                />,
                { theme },
            );
            const details = container.querySelector('details');
            expect(details?.open).toBe(false);
            await user.click(screen.getByText('Technical details'));
            expect(details?.open).toBe(true);
            expect(screen.getByText(HASH).className).toContain('truncate');
            await user.click(screen.getByRole('button', { name: 'Copy SHA-256' }));
            expect(copy).toHaveBeenCalledWith(HASH);
            await expectNoAxeViolations(container);
        },
    );

    it('takes its own title, and renders nothing without items', () => {
        const { container, rerender } = renderUi(
            <TechnicalDetails title="Bundle" items={[{ label: 'Hash', value: 'abc' }]} />,
        );
        expect(screen.getByText('Bundle')).toBeDefined();
        rerender(<TechnicalDetails items={[]} />);
        expect(container.childElementCount).toBe(0);
    });
});
