import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Button } from '../button/button';
import { Dialog } from '../dialog/dialog';
import { IconButton } from '../icon-button/icon-button';
import { Tooltip } from './tooltip';

const isOpen = (element: HTMLElement | null) => element?.dataset['fakePopoverOpen'] === 'true';

describe('Tooltip', () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['light', 'dark'] as const)('describes its trigger and shows on hover and focus (%s)', async (theme) => {
        const { container, user } = renderUi(
            <Tooltip content="Agents">
                {(props) => (
                    <button type="button" aria-label="Open agents" {...props}>
                        {'A'}
                    </button>
                )}
            </Tooltip>,
            { theme },
        );
        const trigger = screen.getByRole('button', { name: 'Open agents' });
        const tip = screen.getByRole('tooltip', { hidden: true });
        expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
        expect(isOpen(tip)).toBe(false);

        await user.hover(trigger);
        expect(isOpen(tip)).toBe(true);
        expect(tip.style.top).not.toBe('');
        await user.unhover(trigger);
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(isOpen(tip)).toBe(false);

        await user.tab();
        expect(isOpen(tip)).toBe(true);
        await expectNoAxeViolations(container);
        await user.tab();
        expect(isOpen(tip)).toBe(false);
    });

    it('stays while the pointer moves onto it, and Esc dismisses it without closing the dialog', async () => {
        const onClose = vi.fn();
        const { user } = renderUi(
            <Dialog open onClose={onClose} title="Revoke passkey?">
                <IconButton
                    label="Revoke"
                    icon={<span>{'x'}</span>}
                    disabled
                    disabledReason="It is your last passkey"
                />
            </Dialog>,
        );
        const trigger = screen.getByRole('button', { name: 'Revoke' });
        const tip = screen.getByRole('tooltip', { hidden: true });
        expect(screen.getByRole('dialog').contains(tip)).toBe(true);
        await user.hover(trigger);
        await user.unhover(trigger);
        fireEvent.pointerEnter(tip);
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(isOpen(tip)).toBe(true);
        fireEvent.pointerLeave(tip);
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(isOpen(tip)).toBe(false);

        act(() => {
            trigger.focus();
        });
        expect(isOpen(tip)).toBe(true);
        await user.keyboard('{Escape}');
        expect(isOpen(tip)).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('shows a disabled reason on tap, and hides on scroll', async () => {
        const onClick = vi.fn();
        const { user } = renderUi(
            <Button disabled disabledReason="Add another passkey first" onClick={onClick} onFocus={vi.fn()}>
                {'Remove'}
            </Button>,
        );
        const tip = screen.getByRole('tooltip', { hidden: true });
        await user.pointer({ keys: '[TouchA]', target: screen.getByRole('button', { name: 'Remove' }) });
        expect(onClick).not.toHaveBeenCalled();
        expect(isOpen(tip)).toBe(true);
        act(() => {
            window.dispatchEvent(new Event('scroll'));
        });
        expect(isOpen(tip)).toBe(false);
    });

    it('keeps the trigger’s own handlers', async () => {
        const onFocus = vi.fn();
        const onBlur = vi.fn();
        const onPointerEnter = vi.fn();
        const onPointerLeave = vi.fn();
        const { user } = renderUi(
            <Button
                disabled
                disabledReason="No permission"
                onFocus={onFocus}
                onBlur={onBlur}
                onPointerEnter={onPointerEnter}
                onPointerLeave={onPointerLeave}
            >
                {'Delete'}
            </Button>,
        );
        const button = screen.getByRole('button', { name: 'Delete' });
        await user.hover(button);
        await user.unhover(button);
        await user.tab();
        await user.tab();
        expect([onFocus, onBlur, onPointerEnter, onPointerLeave].map((spy) => spy.mock.calls.length)).toEqual([
            1, 1, 1, 1,
        ]);
    });

    it('places itself below a trigger at the top edge and inside the viewport', async () => {
        const { user } = renderUi(
            <Tooltip content="A long explanation">
                {(props) => (
                    <button type="button" {...props}>
                        {'Top'}
                    </button>
                )}
            </Tooltip>,
        );
        const trigger = screen.getByRole('button', { name: 'Top' });
        vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(
            DOMRect.fromRect({ x: -40, y: 2, width: 20, height: 20 }),
        );
        const tip = screen.getByRole('tooltip', { hidden: true });
        vi.spyOn(tip, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width: 100, height: 24 }));
        await user.hover(trigger);
        expect(tip.style.top).toBe('28px');
        expect(tip.style.left).toBe('8px');
    });
});
