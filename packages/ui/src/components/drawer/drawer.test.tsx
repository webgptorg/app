import { act, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Drawer } from './drawer';
import type { DrawerSide } from './drawer';

function Harness({
    side,
    onClose = () => undefined,
    initiallyOpen = false,
}: {
    side?: DrawerSide;
    onClose?: () => void;
    initiallyOpen?: boolean;
}) {
    const [open, setOpen] = useState(initiallyOpen);
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    setOpen(true);
                }}
            >
                Menu
            </button>
            <Drawer
                open={open}
                onClose={() => {
                    onClose();
                    setOpen(false);
                }}
                title="Navigation"
                {...(side === undefined ? {} : { side })}
                footer={<button type="button">Sign out</button>}
            >
                <a href="/agents">Agents</a>
            </Drawer>
        </>
    );
}

describe('Drawer', () => {
    it.each(['light', 'dark'] as const)(
        'opens as a named modal side sheet without axe violations (%s)',
        async (theme) => {
            const { container, user } = renderUi(<Harness side="start" />, { theme });
            await user.click(screen.getByRole('button', { name: 'Menu' }));
            const drawer = screen.getByRole('dialog', { name: 'Navigation' });
            expect(drawer.dataset['side']).toBe('start');
            await expectNoAxeViolations(container);
        },
    );

    it('traps focus and returns it to the opener on close', async () => {
        const onClose = vi.fn();
        const { user } = renderUi(<Harness onClose={onClose} />);
        const opener = screen.getByRole('button', { name: 'Menu' });
        await user.click(opener);
        expect(screen.getByRole('dialog').dataset['side']).toBe('end');
        const close = screen.getByRole('button', { name: 'Close' });
        expect(document.activeElement).toBe(close);

        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Agents' }));
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign out' }));
        await user.tab();
        expect(document.activeElement).toBe(close);

        await user.click(close);
        expect(onClose).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(opener);
    });

    it('closes on Esc', async () => {
        const { user } = renderUi(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Menu' }));
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('stays open when mounted open in a strict root', async () => {
        const onClose = vi.fn();
        renderUi(<Harness onClose={onClose} initiallyOpen />, { strict: true });
        await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(screen.getByRole('dialog').hasAttribute('open')).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('renders without a footer', () => {
        renderUi(
            <Drawer open onClose={() => undefined} title="Details">
                <p>Body</p>
            </Drawer>,
        );
        expect(screen.getByRole('dialog', { name: 'Details' }).querySelector('.border-t')).toBeNull();
    });
});
