import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Menu } from './menu';
import type { MenuEntry, MenuProps } from './menu';

function renderMenu(items: readonly MenuEntry[], props: Partial<MenuProps> = {}, theme: 'light' | 'dark' = 'light') {
    return renderUi(
        <>
            <button type="button">Before</button>
            <Menu
                label="Agent actions"
                items={items}
                trigger={(trigger) => (
                    <button type="button" {...trigger}>
                        Actions
                    </button>
                )}
                {...props}
            />
        </>,
        { theme },
    );
}

const rename = vi.fn();
const remove = vi.fn();
const ITEMS: readonly MenuEntry[] = [
    { kind: 'heading', id: 'agent', label: 'Agent' },
    { kind: 'item', id: 'rename', label: 'Rename', description: 'Members see it at once', onSelect: rename },
    { kind: 'item', id: 'archive', label: 'Archive', onSelect: vi.fn(), disabled: true },
    { kind: 'link', id: 'open', label: 'Open in dashboard', href: 'https://app.example/engines', current: true },
    { kind: 'separator', id: 'sep' },
    { kind: 'item', id: 'delete', label: 'Delete', onSelect: remove, tone: 'danger', icon: <span>×</span> },
];

describe('Menu', () => {
    it.each(['light', 'dark'] as const)(
        'wires the trigger to a named menu without axe violations (%s)',
        async (theme) => {
            const { container, user } = renderMenu(ITEMS, {}, theme);
            const trigger = screen.getByRole('button', { name: 'Actions' });
            expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
            expect(trigger.getAttribute('aria-expanded')).toBe('false');

            await user.click(trigger);
            const menu = screen.getByRole('menu', { name: 'Agent actions' });
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
            expect(screen.getByRole('group', { name: 'Agent' })).toBeDefined();
            expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
                'RenameMembers see it at once',
                'Archive',
                'Open in dashboard',
                '×Delete',
            ]);
            expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Rename/ }));
            await expectNoAxeViolations(container);
        },
    );

    it('moves with arrows, Home, End, typeahead and Tab, wrapping and never leaving the menu', async () => {
        const { user } = renderMenu(ITEMS);
        await user.click(screen.getByRole('button', { name: 'Actions' }));
        const [first, second, third, fourth] = screen.getAllByRole('menuitem');

        await user.keyboard('{ArrowDown}');
        expect(document.activeElement).toBe(second);
        expect(second?.tabIndex).toBe(0);
        expect(first?.tabIndex).toBe(-1);
        await user.keyboard('{End}');
        expect(document.activeElement).toBe(fourth);
        await user.keyboard('{ArrowDown}');
        expect(document.activeElement).toBe(first);
        await user.keyboard('{ArrowUp}');
        expect(document.activeElement).toBe(fourth);
        await user.keyboard('{Home}');
        expect(document.activeElement).toBe(first);
        await user.keyboard('o');
        expect(document.activeElement).toBe(third);
        await user.keyboard('q');
        expect(document.activeElement).toBe(third);
        await user.tab();
        expect(document.activeElement).toBe(fourth);
        await user.tab();
        expect(document.activeElement).toBe(first);
        await user.tab({ shift: true });
        expect(document.activeElement).toBe(fourth);
    });

    it('closes on Esc and returns focus to the trigger', async () => {
        const { user } = renderMenu(ITEMS);
        const trigger = screen.getByRole('button', { name: 'Actions' });
        await user.click(trigger);
        await user.keyboard('{Escape}');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
    });

    it('runs an item, closes and returns focus; disabled items do nothing', async () => {
        const { user } = renderMenu(ITEMS);
        const trigger = screen.getByRole('button', { name: 'Actions' });
        await user.click(trigger);
        await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('menuitem', { name: 'Archive' }).getAttribute('aria-disabled')).toBe('true');

        await user.keyboard('{End}{Enter}');
        expect(remove).toHaveBeenCalledOnce();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
    });

    it('opens from the keyboard on the first or the last item, and toggles on click', async () => {
        const { user } = renderMenu(ITEMS, { align: 'end' });
        const trigger = screen.getByRole('button', { name: 'Actions' });
        trigger.focus();
        await user.keyboard('{ArrowUp}');
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.keyboard('{Escape}');
        await user.keyboard('{ArrowDown}');
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Rename/ }));
        await user.keyboard('{Escape}');
        await user.keyboard('{Enter}');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await user.click(trigger);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        await user.keyboard('{Tab}');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('renders links as anchors with their href, marks the current one and closes on activation', async () => {
        const { user } = renderMenu([
            {
                kind: 'link',
                id: 'engine',
                label: 'Lead bot engine',
                href: 'https://lead.engine.example/',
                current: true,
                content: <strong>Lead bot</strong>,
            },
            { kind: 'link', id: 'all', label: 'All engines', href: 'https://app.example/engines' },
        ]);
        const trigger = screen.getByRole('button', { name: 'Actions' });
        await user.click(trigger);
        const current = screen.getByRole('menuitem', { name: 'Lead bot engine' });
        expect(current.tagName).toBe('A');
        expect(current.getAttribute('href')).toBe('https://lead.engine.example/');
        expect(current.getAttribute('aria-current')).toBe('page');
        expect(screen.getByRole('menuitem', { name: 'All engines' }).getAttribute('aria-current')).toBeNull();
        current.addEventListener('click', (event) => {
            event.preventDefault();
        });
        await user.click(current);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('renders a set of choices as menuitemradio with the chosen one checked', async () => {
        const choose = vi.fn();
        const { user } = renderMenu([
            { kind: 'heading', id: 'language', label: 'Language' },
            { kind: 'item', id: 'en', label: 'English', checked: true, onSelect: choose },
            { kind: 'item', id: 'cs', label: 'Čeština', checked: false, onSelect: choose },
        ]);
        await user.click(screen.getByRole('button', { name: 'Actions' }));
        const english = screen.getByRole('menuitemradio', { name: 'English' });
        expect(english.getAttribute('aria-checked')).toBe('true');
        expect(english.querySelector('svg')).not.toBeNull();
        expect(screen.getByRole('menuitemradio', { name: 'Čeština' }).getAttribute('aria-checked')).toBe('false');
        expect(screen.queryAllByRole('menuitem')).toEqual([]);
        await user.keyboard('{ArrowDown}{Enter}');
        expect(choose).toHaveBeenCalledOnce();
    });

    it('renders independent toggles as menuitemcheckbox and stays open while they are toggled', async () => {
        const toggle = vi.fn();
        const { user } = renderMenu([
            { kind: 'item', id: 'runs', label: 'Runs', checked: true, checkable: 'checkbox', onSelect: toggle },
            { kind: 'item', id: 'id', label: 'ID', checked: false, checkable: 'checkbox', onSelect: toggle },
        ]);
        const trigger = screen.getByRole('button', { name: 'Actions' });
        await user.click(trigger);
        const runs = screen.getByRole('menuitemcheckbox', { name: 'Runs' });
        expect(runs.getAttribute('aria-checked')).toBe('true');
        await user.click(runs);
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'ID' }));
        expect(toggle).toHaveBeenCalledTimes(2);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
    });

    it('follows light dismiss by the browser', async () => {
        const { user } = renderMenu(ITEMS);
        const trigger = screen.getByRole('button', { name: 'Actions' });
        await user.click(trigger);
        screen.getByRole('menu').hidePopover();
        await vi.waitFor(() => {
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
        });
    });

    it('places the menu under the trigger and inside the viewport, flipping above when there is no room', async () => {
        const { user } = renderMenu(ITEMS, { align: 'end' });
        const trigger = screen.getByRole('button', { name: 'Actions' });
        const menu = screen.getByRole('menu', { hidden: true });
        vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(300, 700, 40, 32));
        vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 120));
        Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 360 });
        await user.click(trigger);
        expect(menu.style.left).toBe('140px');
        expect(menu.style.top).toBe(`${String(700 - 4 - 120)}px`);
        window.dispatchEvent(new Event('resize'));
        expect(menu.style.left).toBe('140px');
        Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 0 });
    });

    it('matches the trigger width when asked, and lines up an end-aligned menu with the wider box', async () => {
        const { user } = renderMenu(ITEMS, { align: 'end', matchTriggerWidth: true });
        const trigger = screen.getByRole('button', { name: 'Actions' });
        const menu = screen.getByRole('menu', { hidden: true });
        vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 240, 40));
        vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 192, 120));
        Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });
        await user.click(trigger);
        expect(menu.style.minWidth).toBe('240px');
        expect(menu.style.left).toBe('40px');
        Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 0 });
    });

    it('sizes to its content by default', async () => {
        const { user } = renderMenu(ITEMS);
        const trigger = screen.getByRole('button', { name: 'Actions' });
        vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 240, 40));
        await user.click(trigger);
        expect(screen.getByRole('menu').style.minWidth).toBe('');
    });
});
