import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Hovercard, HOVERCARD_LONG_PRESS_MS, HOVERCARD_OPEN_DELAY_MS } from './hovercard';

const isOpen = (element: HTMLElement | null) => element?.dataset['fakePopoverOpen'] === 'true';

function Sample({ onOpen = vi.fn() }: { readonly onOpen?: () => void }) {
    return (
        <p>
            <Hovercard
                label="Copywriter"
                content={
                    <span>
                        {'Writes copy. '}
                        <button type="button" onClick={onOpen}>
                            {'Open agent'}
                        </button>
                    </span>
                }
            >
                {(props) => (
                    <button type="button" {...props}>
                        {'@Copywriter'}
                    </button>
                )}
            </Hovercard>
            <button type="button">{'After'}</button>
        </p>
    );
}

const card = () => screen.getByRole('dialog', { hidden: true });
const trigger = () => screen.getByRole('button', { name: '@Copywriter' });

describe('Hovercard', () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['light', 'dark'] as const)('opens after a hover delay, not on a pass-over (%s)', async (theme) => {
        const { container } = renderUi(<Sample />, { theme });
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        expect(trigger().getAttribute('aria-controls')).toBe(card().id);

        fireEvent.pointerEnter(trigger(), { pointerType: 'mouse' });
        act(() => {
            vi.advanceTimersByTime(HOVERCARD_OPEN_DELAY_MS - 50);
        });
        fireEvent.pointerLeave(trigger());
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(isOpen(card())).toBe(false);

        fireEvent.pointerEnter(trigger(), { pointerType: 'mouse' });
        act(() => {
            vi.advanceTimersByTime(HOVERCARD_OPEN_DELAY_MS);
        });
        expect(isOpen(card())).toBe(true);
        expect(trigger().getAttribute('aria-expanded')).toBe('true');
        expect(card().getAttribute('aria-label')).toBe('Copywriter');
        expect(card().style.top).not.toBe('');
        await expectNoAxeViolations(container);

        fireEvent.pointerLeave(trigger());
        fireEvent.pointerEnter(card());
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(isOpen(card())).toBe(true);
        fireEvent.pointerLeave(card());
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(isOpen(card())).toBe(false);
    });

    it('ignores touch hover, so a tap stays the trigger’s own action', () => {
        renderUi(<Sample />);
        fireEvent.pointerEnter(trigger(), { pointerType: 'touch' });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(isOpen(card())).toBe(false);
    });

    it('opens on a long press on a touch screen, swallowing the click that ends it, and a tap elsewhere closes it', () => {
        const onClick = vi.fn();
        renderUi(
            <div>
                <Hovercard label="Copywriter" content={<span>{'Writes copy.'}</span>}>
                    {(props) => (
                        <button type="button" {...props} onClick={onClick}>
                            {'@Copywriter'}
                        </button>
                    )}
                </Hovercard>
                <button type="button">{'Elsewhere'}</button>
            </div>,
        );
        fireEvent.pointerDown(trigger(), { pointerType: 'touch' });
        act(() => {
            vi.advanceTimersByTime(HOVERCARD_LONG_PRESS_MS);
        });
        expect(isOpen(card())).toBe(true);
        fireEvent.pointerUp(trigger(), { pointerType: 'touch' });
        fireEvent.pointerLeave(trigger(), { pointerType: 'touch' });
        fireEvent.click(trigger(), { detail: 1 });
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(onClick).not.toHaveBeenCalled();
        expect(isOpen(card())).toBe(true);

        fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }), { pointerType: 'touch' });
        expect(isOpen(card())).toBe(false);

        fireEvent.pointerDown(trigger(), { pointerType: 'touch' });
        fireEvent.pointerUp(trigger(), { pointerType: 'touch' });
        fireEvent.click(trigger(), { detail: 1 });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(onClick).toHaveBeenCalledOnce();
        expect(isOpen(card())).toBe(false);
    });

    it('lets Enter activate the trigger after a long press that ended without a click', () => {
        const onClick = vi.fn();
        renderUi(
            <Hovercard label="Copywriter" content={<span>{'Writes copy.'}</span>}>
                {(props) => (
                    <button type="button" {...props} onClick={onClick}>
                        {'@Copywriter'}
                    </button>
                )}
            </Hovercard>,
        );
        fireEvent.pointerDown(trigger(), { pointerType: 'touch' });
        act(() => {
            vi.advanceTimersByTime(HOVERCARD_LONG_PRESS_MS);
        });
        fireEvent.pointerUp(trigger(), { pointerType: 'touch' });
        fireEvent.click(trigger(), { detail: 0 });
        expect(onClick).toHaveBeenCalledOnce();
    });

    it('lets a scroll cancel the press, and opens at once when the phone raises its own menu', () => {
        renderUi(<Sample />);
        fireEvent.pointerDown(trigger(), { pointerType: 'mouse', button: 2 });
        const rightClick = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        act(() => {
            trigger().dispatchEvent(rightClick);
        });
        expect(rightClick.defaultPrevented).toBe(false);
        expect(isOpen(card())).toBe(false);

        fireEvent.pointerDown(trigger(), { pointerType: 'touch' });
        fireEvent.pointerCancel(trigger(), { pointerType: 'touch' });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(isOpen(card())).toBe(false);

        fireEvent.pointerDown(trigger(), { pointerType: 'touch' });
        const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        act(() => {
            trigger().dispatchEvent(menu);
        });
        expect(menu.defaultPrevented).toBe(true);
        expect(isOpen(card())).toBe(true);
    });

    it('opens on keyboard focus, lets Tab into its actions, and Esc returns focus to the trigger', async () => {
        const onOpen = vi.fn();
        const { user } = renderUi(<Sample onOpen={onOpen} />);
        await user.tab();
        expect(document.activeElement).toBe(trigger());
        expect(isOpen(card())).toBe(true);

        await user.tab();
        const action = screen.getByRole('button', { name: 'Open agent' });
        expect(document.activeElement).toBe(action);
        expect(isOpen(card())).toBe(true);
        await user.keyboard('{Enter}');
        expect(onOpen).toHaveBeenCalledOnce();

        await user.keyboard('{Escape}');
        expect(isOpen(card())).toBe(false);
        expect(document.activeElement).toBe(trigger());
    });

    it('closes when focus leaves both the trigger and the card, and on scroll', async () => {
        const { user } = renderUi(<Sample />);
        await user.tab();
        expect(isOpen(card())).toBe(true);
        await user.tab();
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));
        expect(isOpen(card())).toBe(false);

        await user.tab({ shift: true });
        expect(document.activeElement).toBe(trigger());
        expect(isOpen(card())).toBe(true);
        act(() => {
            window.dispatchEvent(new Event('scroll'));
        });
        expect(isOpen(card())).toBe(false);
    });

    it('stops Esc from reaching anything around it', async () => {
        const outer = vi.fn();
        const { user } = renderUi(
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions
            <div
                onKeyDown={(event) => {
                    if (event.key === 'Escape') outer();
                }}
            >
                <Sample />
            </div>,
        );
        await user.tab();
        await user.keyboard('{Escape}');
        expect(outer).not.toHaveBeenCalled();
        await user.keyboard('{Escape}');
        expect(outer).toHaveBeenCalledOnce();
    });
});
