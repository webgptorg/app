import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { CommandPalette } from './command-palette';
import type { CommandPaletteGroup, CommandPaletteItem } from './command-palette';

const GROUPS: readonly CommandPaletteGroup[] = [
    {
        id: 'navigation',
        label: 'Go to',
        items: [
            { id: 'agents', label: 'Agents' },
            { id: 'settings', label: 'Settings' },
        ],
    },
    { id: 'empty', label: 'Runs', items: [] },
    {
        id: 'found',
        label: 'Agents',
        items: [{ id: 'agent-ada', label: '<img src=x onerror=alert(1)>', detail: 'Ada' }],
    },
];

function Harness({
    groups = GROUPS,
    onSelect = () => undefined,
    onActiveChange,
    loading = false,
    hints = false,
}: {
    groups?: readonly CommandPaletteGroup[];
    onSelect?: (item: CommandPaletteItem) => void;
    onActiveChange?: (item: CommandPaletteItem) => void;
    loading?: boolean;
    hints?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    setOpen(true);
                }}
            >
                Search
            </button>
            <CommandPalette
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                title="Command palette"
                label="Search or jump to"
                query={query}
                onQueryChange={setQuery}
                groups={groups.map((group) => ({
                    ...group,
                    items: group.items.filter((item) => item.label.includes(query)),
                }))}
                onSelect={onSelect}
                {...(onActiveChange === undefined ? {} : { onActiveChange })}
                loading={loading}
                emptyText="Nothing matches"
                resultsText={(count) => `${String(count)} results`}
                {...(hints
                    ? {
                          placeholder: 'Jump to…',
                          keyHints: [
                              { keys: '↵', label: 'Open' },
                              { keys: 'Esc', label: 'Close' },
                          ],
                      }
                    : {})}
            />
        </>
    );
}

const box = () => screen.getByRole('combobox', { name: 'Search or jump to' });
const activeOption = () => document.getElementById(box().getAttribute('aria-activedescendant') ?? '');

describe('CommandPalette', () => {
    it.each(['light', 'dark'] as const)(
        'opens a combobox with grouped options and no axe violations (%s)',
        async (theme) => {
            const { container, user } = renderUi(<Harness />, { theme });
            await user.click(screen.getByRole('button', { name: 'Search' }));

            expect(screen.getByRole('dialog', { name: 'Command palette' }).hasAttribute('open')).toBe(true);
            expect(document.activeElement).toBe(box());
            expect(box().getAttribute('aria-expanded')).toBe('true');
            expect(box().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
            expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-labelledby'))).toHaveLength(2);
            expect(screen.getByRole('group', { name: 'Go to' })).toBeDefined();
            expect(screen.queryByRole('group', { name: 'Runs' })).toBeNull();
            expect(activeOption()?.textContent).toBe('Agents');
            expect(screen.getByRole('status').textContent).toBe('3 results');
            await expectNoAxeViolations(container);
        },
    );

    it('moves the active option with the arrows, wrapping, and selects it with Enter', async () => {
        const onSelect = vi.fn();
        const onActiveChange = vi.fn();
        const { user } = renderUi(<Harness onSelect={onSelect} onActiveChange={onActiveChange} />);
        await user.click(screen.getByRole('button', { name: 'Search' }));

        await user.keyboard('{ArrowDown}');
        expect(activeOption()?.textContent).toBe('Settings');
        expect(activeOption()?.getAttribute('aria-selected')).toBe('true');
        await user.keyboard('{ArrowDown}');
        expect(activeOption()?.textContent).toContain('Ada');
        expect(onActiveChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'agent-ada' }));
        await user.keyboard('{ArrowDown}');
        expect(activeOption()?.textContent).toBe('Agents');
        await user.keyboard('{ArrowUp}');
        expect(activeOption()?.textContent).toContain('Ada');
        await user.keyboard('{Control>}{Home}{/Control}');
        expect(activeOption()?.textContent).toBe('Agents');
        await user.keyboard('{Control>}{End}{/Control}');
        expect(activeOption()?.textContent).toContain('Ada');
        await user.keyboard('{Home}');
        expect(activeOption()?.textContent).toContain('Ada');

        await user.keyboard('{Enter}');
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-ada' }));
    });

    it('takes a shorter placeholder than its name and shows key hints out of the accessibility tree', async () => {
        const { container, user } = renderUi(<Harness hints />);
        await user.click(screen.getByRole('button', { name: 'Search' }));

        expect(box().getAttribute('placeholder')).toBe('Jump to…');
        const hints = container.ownerDocument.querySelector('[aria-hidden="true"] kbd')?.parentElement?.parentElement;
        expect(hints?.textContent).toBe('↵OpenEscClose');
        expect(hints?.getAttribute('aria-hidden')).toBe('true');
        expect(box().getAttribute('placeholder')).not.toBe(box().getAttribute('aria-label'));
        await expectNoAxeViolations(container);
    });

    it('uses its name as the placeholder and shows no hints unless given', async () => {
        const { user } = renderUi(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Search' }));

        expect(box().getAttribute('placeholder')).toBe('Search or jump to');
        expect(document.querySelector('kbd')).toBeNull();
    });

    it('renders untrusted labels as text', async () => {
        const { user } = renderUi(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Search' }));
        const option = screen.getByRole('option', { name: /onerror/ });
        expect(option.querySelector('img')).toBeNull();
        expect(option.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('activates an option under the pointer and selects it on click', async () => {
        const onSelect = vi.fn();
        const onActiveChange = vi.fn();
        const { user } = renderUi(<Harness onSelect={onSelect} onActiveChange={onActiveChange} />);
        await user.click(screen.getByRole('button', { name: 'Search' }));
        const settings = screen.getByRole('option', { name: 'Settings' });

        await user.hover(settings);
        expect(onActiveChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'settings' }));
        expect(settings.getAttribute('aria-selected')).toBe('true');
        await user.click(settings);
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'settings' }));
        expect(document.activeElement).toBe(box());
    });

    it('filters as the owner narrows the groups, and says when nothing matches', async () => {
        const onSelect = vi.fn();
        const { container, user } = renderUi(<Harness onSelect={onSelect} />);
        await user.click(screen.getByRole('button', { name: 'Search' }));

        await user.type(box(), 'Sett');
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Settings']);
        expect(activeOption()?.textContent).toBe('Settings');
        await user.type(box(), 'xyz');
        expect(screen.queryAllByRole('option')).toEqual([]);
        expect(screen.getByText('Nothing matches')).toBeDefined();
        expect(screen.getByRole('status').textContent).toBe('0 results');
        await expectNoAxeViolations(container);
        await user.keyboard('{ArrowDown}{Enter}');
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('shows a spinner instead of the empty text while results load', async () => {
        const { user } = renderUi(<Harness groups={[]} loading />);
        await user.click(screen.getByRole('button', { name: 'Search' }));
        expect(screen.queryByText('Nothing matches')).toBeNull();
        expect(screen.getByRole('status').textContent).toBe('');
    });

    it('closes on Esc and returns focus to the opener', async () => {
        const { user } = renderUi(<Harness />);
        const opener = screen.getByRole('button', { name: 'Search' });
        await user.click(opener);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('combobox')).toBeNull();
        expect(document.activeElement).toBe(opener);
    });
});
