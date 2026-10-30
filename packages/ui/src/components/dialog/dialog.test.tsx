import { act, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Dialog } from './dialog';

/** Lets the dialog's queued `close` event, if any, fire. */
async function flushCloseEvents(): Promise<void> {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

function Harness({
    onClose = () => undefined,
    withInitialFocus = false,
    initiallyOpen = false,
}: {
    onClose?: () => void;
    withInitialFocus?: boolean;
    initiallyOpen?: boolean;
}) {
    const [open, setOpen] = useState(initiallyOpen);
    const nameRef = useRef<HTMLInputElement>(null);
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    setOpen(true);
                }}
            >
                Rename
            </button>
            <button type="button">Elsewhere</button>
            <Dialog
                open={open}
                onClose={() => {
                    onClose();
                    setOpen(false);
                }}
                title="Rename agent"
                description="Members see the new name at once."
                {...(withInitialFocus ? { initialFocusRef: nameRef } : {})}
                footer={
                    <button
                        type="button"
                        onClick={() => {
                            setOpen(false);
                        }}
                    >
                        Save
                    </button>
                }
            >
                <label>
                    Name
                    <input ref={nameRef} />
                </label>
            </Dialog>
        </>
    );
}

describe('Dialog', () => {
    it.each(['light', 'dark'] as const)('opens as a named modal and has no axe violations (%s)', async (theme) => {
        const { container, user } = renderUi(<Harness />, { theme });
        await user.click(screen.getByRole('button', { name: 'Rename' }));

        const dialog = screen.getByRole('dialog', { name: 'Rename agent' });
        expect(dialog.hasAttribute('open')).toBe(true);
        expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByText('Members see the new name at once.').id);
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
        await expectNoAxeViolations(container);
    });

    it('traps Tab and Shift+Tab inside and returns focus to the opener on Esc', async () => {
        const onClose = vi.fn();
        const { user } = renderUi(<Harness onClose={onClose} />);
        const opener = screen.getByRole('button', { name: 'Rename' });
        await user.click(opener);
        const close = screen.getByRole('button', { name: 'Close' });
        const save = screen.getByRole('button', { name: 'Save' });

        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
        await user.tab();
        expect(document.activeElement).toBe(save);
        await user.tab();
        expect(document.activeElement).toBe(close);
        await user.tab({ shift: true });
        expect(document.activeElement).toBe(save);

        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledOnce();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it('moves focus to the initial focus target and closes from the close button and the backdrop', async () => {
        const onClose = vi.fn();
        const { user } = renderUi(<Harness onClose={onClose} withInitialFocus />);
        await user.click(screen.getByRole('button', { name: 'Rename' }));
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));

        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole('button', { name: 'Rename' }));
        const dialog = screen.getByRole('dialog');
        await user.click(dialog);
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('reports a close it did not ask for, and ignores clicks inside the content', async () => {
        const onClose = vi.fn();
        const { user } = renderUi(<Harness onClose={onClose} />);
        await user.click(screen.getByRole('button', { name: 'Rename' }));
        await user.click(screen.getByText('Members see the new name at once.'));
        expect(onClose).not.toHaveBeenCalled();

        screen.getByRole<HTMLDialogElement>('dialog').close();
        await flushCloseEvents();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('stays open when mounted open in a strict root, and still reports Esc and the close button once', async () => {
        const onClose = vi.fn();
        const { user } = renderUi(<Harness onClose={onClose} initiallyOpen />, { strict: true });
        await flushCloseEvents();
        expect(screen.getByRole('dialog').hasAttribute('open')).toBe(true);
        expect(onClose).not.toHaveBeenCalled();

        await user.keyboard('{Escape}');
        await flushCloseEvents();
        expect(onClose).toHaveBeenCalledOnce();
        expect(screen.queryByRole('dialog')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Rename' }));
        await user.click(screen.getByRole('button', { name: 'Close' }));
        await flushCloseEvents();
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('ignores the close event of a dialog shown again before it arrived', async () => {
        const onClose = vi.fn();
        const dialogAt = (initialFocusRef: { current: HTMLElement | null }) => (
            <Dialog open onClose={onClose} title="Notice" initialFocusRef={initialFocusRef}>
                <p>Read only.</p>
            </Dialog>
        );
        const { rerender } = renderUi(dialogAt({ current: null }));
        // A new ref object re-runs the show effect: close() then showModal() within one render.
        rerender(dialogAt({ current: null }));
        await flushCloseEvents();
        expect(screen.getByRole('dialog').hasAttribute('open')).toBe(true);
        expect(onClose).not.toHaveBeenCalled();

        screen.getByRole<HTMLDialogElement>('dialog').close();
        await flushCloseEvents();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('omits the description link without a description', () => {
        renderUi(
            <Dialog open onClose={() => undefined} title="Notice" size="sm">
                <p>Read only.</p>
            </Dialog>,
        );
        const dialog = screen.getByRole('dialog', { name: 'Notice' });
        expect(dialog.getAttribute('aria-describedby')).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    });
});
