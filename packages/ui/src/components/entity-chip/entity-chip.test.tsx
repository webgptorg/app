import { act, fireEvent, screen } from '@testing-library/react';
import { ListTodo } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { HOVERCARD_OPEN_DELAY_MS } from '../hovercard/hovercard';
import { EntityChip } from './entity-chip';

const isOpen = (element: HTMLElement | null) => element?.dataset['fakePopoverOpen'] === 'true';
const card = () => screen.getByRole('dialog', { hidden: true });

describe('EntityChip', () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['light', 'dark'] as const)('is plain text without an action (%s)', async (theme) => {
        const { container } = renderUi(
            <p>
                <EntityChip
                    label="<b>Ship billing</b>"
                    leading={<ListTodo />}
                    tint="var(--color-danger)"
                    status="danger"
                    statusLabel="Failed"
                />
            </p>,
            { theme },
        );
        expect(screen.queryByRole('button')).toBeNull();
        expect(container.querySelector('b')).toBeNull();
        expect(screen.getByText('<b>Ship billing</b>')).toBeDefined();
        expect(screen.getByText(', Failed').className).toBe('sr-only');
        const chip = container.querySelector('p > span') as HTMLElement;
        expect(chip.style.getPropertyValue('--tint')).toBe('var(--color-danger)');
        expect(chip.className).toMatch(/truncate|inline-flex/);
        await expectNoAxeViolations(container);
    });

    it('opens its hovercard on hover and toggles it on click', async () => {
        const { container } = renderUi(
            <p>
                <EntityChip
                    label="Ada"
                    tone="agent"
                    tint="#123456"
                    wrap
                    hovercard={{ label: 'Ada', content: <span>{'Writes copy.'}</span> }}
                />
            </p>,
        );
        const chip = screen.getByRole('button', { name: 'Ada' });
        expect(chip.className).toMatch(/box-decoration-break/);
        fireEvent.pointerEnter(chip, { pointerType: 'mouse' });
        act(() => {
            vi.advanceTimersByTime(HOVERCARD_OPEN_DELAY_MS);
        });
        expect(isOpen(card())).toBe(true);
        expect(screen.getByText('Writes copy.')).toBeDefined();
        fireEvent.click(chip);
        expect(isOpen(card())).toBe(false);
        fireEvent.click(chip);
        expect(isOpen(card())).toBe(true);
        await expectNoAxeViolations(container);
    });

    it('hands clicks and the hovercard to its own handler', () => {
        const onClick = vi.fn();
        renderUi(<EntityChip label="Max" onClick={onClick} hovercard={{ label: 'Max', content: 'Card' }} />);
        fireEvent.click(screen.getByRole('button', { name: 'Max' }));
        expect(onClick).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ open: false }));
    });

    it('renders through `render` as a link, with the hovercard wiring', () => {
        renderUi(
            <EntityChip
                label="Daily digest"
                hovercard={{ label: 'Daily digest', content: 'Runs at 8:00' }}
                render={({ children, ...props }) => (
                    <a href="/tasks/digest" {...props}>
                        {children}
                    </a>
                )}
            />,
        );
        const link = screen.getByRole('link', { name: 'Daily digest' });
        expect(link.getAttribute('aria-haspopup')).toBe('dialog');
        expect(link.className).toMatch(/cursor-pointer/);
    });

    it('stays quiet when not interactive, even with a hovercard', () => {
        renderUi(<EntityChip label="Iris" interactive={false} hovercard={{ label: 'Iris', content: 'Card' }} />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    });
});
