import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import type { MenuEntry } from '../menu/menu';
import { ActionMenu } from './action-menu';

const duplicate = vi.fn();
const remove = vi.fn();
const ITEMS: readonly MenuEntry[] = [
    { kind: 'item', id: 'duplicate', label: 'Duplicate', onSelect: duplicate },
    { kind: 'separator', id: 'danger' },
    { kind: 'item', id: 'delete', label: 'Delete trigger', tone: 'danger', onSelect: remove },
];

describe('ActionMenu', () => {
    it.each(['light', 'dark'] as const)(
        'is a named ⋯ button opening a menu with the destructive item in danger text (%s)',
        async (theme) => {
            const { container, user } = renderUi(<ActionMenu items={ITEMS} />, { theme });
            const trigger = screen.getByRole('button', { name: 'More actions' });
            expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
            expect(trigger.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

            await user.click(trigger);
            screen.getByRole('menu', { name: 'More actions' });
            const destructive = screen.getByRole('menuitem', { name: 'Delete trigger' });
            expect(destructive.className).toContain('text-(--menu-danger)');
            expect(screen.getByRole('menuitem', { name: 'Duplicate' }).className).not.toContain('--menu-danger');
            await expectNoAxeViolations(container);
        },
    );

    it('runs an item by keyboard and returns focus to the trigger', async () => {
        const { user } = renderUi(<ActionMenu items={ITEMS} label="Actions for Weekly report" />);
        const trigger = screen.getByRole('button', { name: 'Actions for Weekly report' });
        trigger.focus();
        await user.keyboard('{Enter}');
        await user.keyboard('{ArrowDown}{Enter}');
        expect(remove).toHaveBeenCalledOnce();
        expect(duplicate).not.toHaveBeenCalled();
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('closes on Escape without running anything', async () => {
        remove.mockClear();
        const { user } = renderUi(<ActionMenu items={ITEMS} />);
        await user.click(screen.getByRole('button', { name: 'More actions' }));
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(remove).not.toHaveBeenCalled();
    });

    it('renders nothing when no entry is actionable', () => {
        const { container } = renderUi(<ActionMenu items={[{ kind: 'separator', id: 'only' }]} />);
        expect(container.childElementCount).toBe(0);
        expect(screen.queryByRole('button')).toBeNull();
    });
});
