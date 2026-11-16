import { screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { placePopover } from './anchored-popover';
import { FilterBar, filterField } from './filter-bar';
import type { FilterBarDateRange, FilterBarProps } from './filter-bar';
import { clearField, isFieldActive, matchesQuery, selectedOptions } from './filter-fields';

type Status = 'running' | 'waiting' | 'failed' | 'stopped';
type Source = 'chat' | 'email';

interface State {
    readonly q: string;
    readonly status: readonly Status[];
    readonly agent: readonly string[];
    readonly owner: readonly string[];
    readonly source: Source | undefined;
    readonly queued: FilterBarDateRange;
}
const NONE: State = {
    q: '',
    status: [],
    agent: [],
    owner: [],
    source: undefined,
    queued: { from: undefined, to: undefined },
};

const AGENTS = [
    { value: 'ada', label: 'Ada', icon: <span data-testid="avatar-ada" /> },
    { value: 'max', label: 'Max' },
    { value: 'zdenek', label: 'Zdeněk' },
];

const seen: { state: State } = { state: NONE };

function Harness({
    initial = NONE,
    empty = false,
    withClear = true,
    extra,
}: {
    readonly initial?: State;
    readonly empty?: boolean;
    readonly withClear?: boolean;
    readonly extra?: Partial<FilterBarProps>;
}) {
    const [state, setState] = useState(initial);
    useEffect(() => {
        seen.state = state;
    });
    const set = (patch: Partial<State>) => {
        setState((current) => ({ ...current, ...patch }));
    };
    return (
        <FilterBar
            empty={empty}
            search={{
                label: 'Search runs',
                value: state.q,
                onChange: (q) => {
                    set({ q });
                },
            }}
            fields={[
                filterField.multiEnum<Status>({
                    id: 'status',
                    label: 'Status',
                    options: [
                        { value: 'running', label: 'Running' },
                        { value: 'waiting', label: 'Waiting' },
                        { value: 'failed', label: 'Failed' },
                        { value: 'stopped', label: 'Stopped' },
                    ],
                    value: state.status,
                    onChange: (status) => {
                        set({ status });
                    },
                }),
                filterField.entity({
                    id: 'agent',
                    label: 'Agent',
                    options: AGENTS,
                    value: state.agent,
                    onChange: (agent) => {
                        set({ agent });
                    },
                }),
                filterField.entity({
                    id: 'owner',
                    label: 'Owner',
                    multiple: false,
                    options: AGENTS,
                    value: state.owner,
                    onChange: (owner) => {
                        set({ owner });
                    },
                }),
                filterField.enum<Source>({
                    id: 'source',
                    label: 'Source',
                    options: [
                        { value: 'chat', label: 'Chat' },
                        { value: 'email', label: 'Email' },
                    ],
                    value: state.source,
                    onChange: (source) => {
                        set({ source });
                    },
                }),
                filterField.dateRange({
                    id: 'queued',
                    label: 'Queued',
                    hint: 'Days in Europe/Prague',
                    value: state.queued,
                    onChange: (queued) => {
                        set({ queued });
                    },
                }),
            ]}
            {...(withClear
                ? {
                      onClear: () => {
                          setState(NONE);
                      },
                  }
                : {})}
            {...extra}
        />
    );
}

const dialog = () => screen.getByRole('dialog');

afterEach(() => {
    seen.state = NONE;
});

describe('FilterBar', () => {
    it.each(['light', 'dark'] as const)('is one quiet search bar with "+ Filter" (%s)', async (theme) => {
        const { container } = renderUi(<Harness />, { theme });
        const bar = screen.getByRole('search', { name: 'Filters' });
        expect(within(bar).getByRole('searchbox', { name: 'Search runs' })).toBeDefined();
        const add = within(bar).getByRole('button', { name: 'Filter' });
        expect(add.getAttribute('aria-haspopup')).toBe('dialog');
        expect(add.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
        expect(screen.queryByRole('listitem')).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('adds a multi-value filter from the keyboard: fields, then values, as one chip', async () => {
        const { user, container } = renderUi(<Harness />);
        const add = screen.getByRole('button', { name: 'Filter' });
        add.focus();
        await user.keyboard('{Enter}');
        expect(add.getAttribute('aria-expanded')).toBe('true');
        const fields = within(dialog()).getByRole('listbox', { name: 'Filter by' });
        expect(document.activeElement).toBe(fields);
        expect(
            within(fields)
                .getAllByRole('option')
                .map((option) => option.textContent),
        ).toEqual(['Status', 'Agent', 'Owner', 'Source', 'Queued']);
        await expectNoAxeViolations(container);

        await user.keyboard('{Enter}');
        const values = within(dialog()).getByRole('listbox', { name: 'Status' });
        expect(values.getAttribute('aria-multiselectable')).toBe('true');
        expect(document.activeElement).toBe(values);
        await user.keyboard(' {ArrowDown} {ArrowUp}{ArrowUp}{Enter}');
        expect(seen.state.status).toEqual(['running', 'waiting', 'stopped']);
        expect(within(values).getByRole('option', { name: 'Stopped' }).getAttribute('aria-selected')).toBe('true');
        await user.keyboard('{End}{Enter}{Home}');
        expect(seen.state.status).toEqual(['running', 'waiting']);
        expect(values.getAttribute('aria-activedescendant')).toBe(
            within(values).getByRole('option', { name: 'Running' }).id,
        );
        await expectNoAxeViolations(container);

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(add);
        const chip = screen.getByRole('button', { name: 'Status: Running, Waiting' });
        // The space after the colon is rendered text, not whitespace a flex box drops, so browsers name it the same.
        expect(chip.querySelector('[data-chip-text]')?.textContent).toBe('Status: Running, Waiting');
        expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
        expect(screen.getByRole('button', { name: 'Remove Status: Running, Waiting' })).toBeDefined();
    });

    it('names the values a chip counts as "+N" for screen readers', () => {
        renderUi(<Harness initial={{ ...NONE, status: ['running', 'waiting', 'failed', 'stopped'] }} />);
        const chip = screen.getByRole('button', { name: 'Status: Running, Waiting, Failed, Stopped' });
        expect(chip.textContent).toContain('+2');
        expect(screen.getByRole('button', { name: 'Remove Status: Running, Waiting, Failed, Stopped' })).toBeDefined();
    });

    it('searches an entity list, ignoring accents, and steps back to the fields with Backspace', async () => {
        const { user } = renderUi(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Filter' }));
        await user.click(within(dialog()).getByRole('option', { name: 'Agent' }));
        const search = within(dialog()).getByRole('combobox', { name: 'Search Agent' });
        expect(document.activeElement).toBe(search);
        await user.keyboard('zdenek');
        const list = within(dialog()).getByRole('listbox', { name: 'Agent' });
        expect(
            within(list)
                .getAllByRole('option')
                .map((option) => option.textContent),
        ).toEqual(['Zdeněk']);
        expect(search.getAttribute('aria-activedescendant')).toBe(within(list).getByRole('option').id);
        await user.keyboard('{Enter}');
        expect(seen.state.agent).toEqual(['zdenek']);
        // Space types in a search box; it never picks.
        await user.keyboard(' ');
        expect(seen.state.agent).toEqual(['zdenek']);

        await user.clear(search);
        await user.keyboard('qqq');
        expect(within(dialog()).getByRole('status').textContent).toBe('No matches');
        expect(search.getAttribute('aria-activedescendant')).toBeNull();
        await user.keyboard('{Enter}{ArrowDown}');
        expect(seen.state.agent).toEqual(['zdenek']);

        await user.clear(search);
        await user.keyboard('{Backspace}');
        expect(within(dialog()).getByRole('listbox', { name: 'Filter by' })).toBeDefined();
        await user.click(within(dialog()).getByRole('option', { name: 'Agent' }));
        await user.click(within(dialog()).getByRole('button', { name: 'Back to filters' }));
        expect(within(dialog()).getByRole('listbox', { name: 'Filter by' })).toBeDefined();
    });

    it('shows a lone entity with its face, and picks a single entity or enum by pointer, closing', async () => {
        const { user } = renderUi(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Filter' }));
        await user.click(within(dialog()).getByRole('option', { name: 'Owner' }));
        const list = within(dialog()).getByRole('listbox', { name: 'Owner' });
        expect(list.getAttribute('aria-multiselectable')).toBeNull();
        await user.hover(within(list).getByRole('option', { name: 'Max' }));
        expect(within(list).getByRole('option', { name: 'Max' }).hasAttribute('data-active')).toBe(true);
        await user.click(within(list).getByRole('option', { name: 'Ada' }));
        expect(seen.state.owner).toEqual(['ada']);
        expect(screen.queryByRole('dialog')).toBeNull();
        const chip = screen.getByRole('button', { name: 'Owner: Ada' });
        expect(within(chip).getByTestId('avatar-ada')).toBeDefined();

        // A chip opens its own values, without a step back; picking the chosen one again clears it.
        await user.click(chip);
        expect(within(dialog()).queryByRole('button', { name: 'Back to filters' })).toBeNull();
        await user.click(within(dialog()).getByRole('option', { name: 'Ada' }));
        expect(seen.state.owner).toEqual([]);

        await user.click(screen.getByRole('button', { name: 'Filter' }));
        await user.click(within(dialog()).getByRole('option', { name: 'Source' }));
        await user.click(within(dialog()).getByRole('option', { name: 'Email' }));
        expect(seen.state.source).toBe('email');
        expect(screen.queryByRole('dialog')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Source: Email' }));
        await user.click(within(dialog()).getByRole('option', { name: 'Email' }));
        expect(seen.state.source).toBeUndefined();
    });

    it('takes a date range and says it on the chip', async () => {
        const { user, container } = renderUi(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Filter' }));
        await user.click(within(dialog()).getByRole('option', { name: 'Queued' }));
        const from = within(dialog()).getByLabelText('From');
        expect(document.activeElement).toBe(from);
        expect(from.getAttribute('aria-describedby')).toBe(within(dialog()).getByText('Days in Europe/Prague').id);
        await user.type(from, '2026-11-02');
        expect(seen.state.queued).toEqual({ from: '2026-11-02', to: undefined });
        expect(within(dialog()).getByLabelText('To').getAttribute('min')).toBe('2026-11-02');
        await expectNoAxeViolations(container);
        await user.click(within(dialog()).getByRole('button', { name: 'Done' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.getByRole('button', { name: /^Queued: from / })).toBeDefined();
    });

    it.each([
        [{ from: '2026-11-02', to: '2026-11-09' }, /^Queued: Nov 2(, 2026)? – Nov 9(, 2026)?$/],
        [{ from: '2026-11-02', to: '2026-11-02' }, /^Queued: Nov 2(, 2026)?$/],
        [{ from: '2001-01-05', to: undefined }, /^Queued: from Jan 5, 2001$/],
        [{ from: undefined, to: '2026-11-09' }, /^Queued: until /],
    ])('formats a range %o', (queued, name) => {
        renderUi(<Harness initial={{ ...NONE, queued }} />);
        expect(screen.getByRole('button', { name })).toBeDefined();
    });

    it('edits a range from its chip and clears an end', async () => {
        const { user } = renderUi(<Harness initial={{ ...NONE, queued: { from: '2026-11-02', to: '2026-11-09' } }} />);
        await user.click(screen.getByRole('button', { name: /^Queued:/ }));
        expect(within(dialog()).getByLabelText('From').getAttribute('max')).toBe('2026-11-09');
        await user.clear(within(dialog()).getByLabelText('To'));
        expect(seen.state.queued).toEqual({ from: '2026-11-02', to: undefined });
        await user.clear(within(dialog()).getByLabelText('From'));
        expect(seen.state.queued).toEqual({ from: undefined, to: undefined });
    });

    it('removes a filter with its × or with Backspace on the chip, and focus moves to "+ Filter"', async () => {
        const { user } = renderUi(<Harness initial={{ ...NONE, status: ['failed'], source: 'chat' }} />);
        await user.click(screen.getByRole('button', { name: 'Remove Status: Failed' }));
        expect(seen.state.status).toEqual([]);
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Filter' }));
        screen.getByRole('button', { name: 'Source: Chat' }).focus();
        await user.keyboard('{Delete}');
        expect(seen.state.source).toBeUndefined();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Filter' }));
    });

    it('ignores other keys on a chip', async () => {
        const { user } = renderUi(<Harness initial={{ ...NONE, source: 'chat' }} />);
        screen.getByRole('button', { name: 'Source: Chat' }).focus();
        await user.keyboard('a');
        expect(seen.state.source).toBe('chat');
    });

    it('clears everything in one change with onClear, or field by field without it', async () => {
        const busy: State = { ...NONE, q: 'report', status: ['failed'], queued: { from: '2026-11-01', to: undefined } };
        const first = renderUi(<Harness initial={busy} />);
        await first.user.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(seen.state).toEqual(NONE);
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Filter' }));
        first.unmount();

        const second = renderUi(<Harness initial={{ ...busy, owner: ['max'], source: 'chat' }} withClear={false} />);
        await second.user.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(seen.state).toEqual(NONE);
    });

    it('offers Clear while only a search is typed', async () => {
        const { user } = renderUi(<Harness withClear={false} />);
        await user.type(screen.getByRole('searchbox', { name: 'Search runs' }), 'x');
        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(seen.state.q).toBe('');
    });

    it('closes when focus leaves the popover, and toggles from "+ Filter"', async () => {
        const { user } = renderUi(<Harness />);
        const add = screen.getByRole('button', { name: 'Filter' });
        await user.click(add);
        await user.click(add);
        expect(screen.queryByRole('dialog')).toBeNull();
        await user.click(add);
        await user.click(within(dialog()).getByRole('option', { name: 'Queued' }));
        // From the first date, back past the step's header and out of the popover.
        await user.tab({ shift: true });
        await user.tab({ shift: true });
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('keeps an unknown value visible by its raw value', () => {
        renderUi(<Harness initial={{ ...NONE, agent: ['agent-elsewhere'] }} />);
        expect(screen.getByRole('button', { name: 'Agent: agent-elsewhere' })).toBeDefined();
    });

    it('renders nothing for an empty, unfiltered list, but stays while a search or filter emptied it', () => {
        const { rerender } = renderUi(<Harness empty />);
        expect(screen.queryByRole('search')).toBeNull();
        rerender(<Harness empty initial={{ ...NONE, q: 'zzz' }} key="searched" />);
        expect(screen.getByRole('search')).toBeDefined();
        rerender(<Harness empty initial={{ ...NONE, source: 'chat' }} key="filtered" />);
        expect(screen.getByRole('search')).toBeDefined();
    });

    it('sorts from a menu that mirrors the current order', async () => {
        const onChange = vi.fn();
        const sort = {
            options: [
                { id: 'queuedAt', label: 'Queued' },
                { id: 'duration', label: 'Duration' },
            ],
            value: { id: 'queuedAt', desc: true },
            onChange,
        };
        const { user, container, rerender } = renderUi(<Harness extra={{ sort, label: 'Filter runs' }} />);
        const trigger = screen.getByRole('button', { name: 'Sorted by Queued, Sorted descending' });
        await user.click(trigger);
        expect(screen.getByRole('menuitemradio', { name: 'Queued' }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByRole('menuitemradio', { name: 'Descending' }).getAttribute('aria-checked')).toBe('true');
        await expectNoAxeViolations(container);
        await user.click(screen.getByRole('menuitemradio', { name: 'Duration' }));
        expect(onChange).toHaveBeenLastCalledWith({ id: 'duration', desc: true });
        await user.click(trigger);
        await user.click(screen.getByRole('menuitemradio', { name: 'Ascending' }));
        expect(onChange).toHaveBeenLastCalledWith({ id: 'queuedAt', desc: false });

        rerender(<Harness extra={{ sort: { ...sort, value: undefined } }} />);
        await user.click(screen.getByRole('button', { name: 'Sort' }));
        const ascending = screen.getByRole('menuitemradio', { name: 'Ascending' });
        expect(ascending.getAttribute('aria-disabled')).toBe('true');
        await user.click(ascending);
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    it('offers the columns in its overflow menu', async () => {
        const onToggle = vi.fn();
        const { user } = renderUi(
            <Harness
                extra={{
                    columns: {
                        items: [
                            { id: 'status', label: 'Status', visible: true, disabled: true },
                            { id: 'cost', label: 'Cost', visible: false, disabled: false },
                        ],
                        onToggle,
                    },
                }}
            />,
        );
        await user.click(screen.getByRole('button', { name: 'View options' }));
        expect(screen.getByRole('menuitemcheckbox', { name: 'Status' }).getAttribute('aria-disabled')).toBe('true');
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Cost' }));
        expect(onToggle).toHaveBeenCalledWith('cost');
    });

    it('shows no Sort or overflow when there is nothing to offer', () => {
        renderUi(
            <Harness
                extra={{
                    sort: { options: [], value: undefined, onChange: vi.fn() },
                    columns: { items: [], onToggle: vi.fn() },
                }}
            />,
        );
        expect(screen.queryByRole('button', { name: 'Sort' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'View options' })).toBeNull();
    });

    it('works with neither a search nor fields', () => {
        renderUi(<FilterBar sort={{ options: [{ id: 'a', label: 'A' }], value: undefined, onChange: vi.fn() }} />);
        expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Sort' })).toBeDefined();
    });
});

describe('filter fields', () => {
    it('hand consumers only values their options list', () => {
        const onEnum = vi.fn();
        const onList = vi.fn();
        const options = [{ value: 'a' as const, label: 'A' }];
        const enumField = filterField.enum<'a'>({ id: 'e', label: 'E', options, value: undefined, onChange: onEnum });
        const listField = filterField.multiEnum<'a'>({ id: 'm', label: 'M', options, value: [], onChange: onList });
        const entity = filterField.entity<'a'>({ id: 'n', label: 'N', options, value: ['a'], onChange: onList });
        if (enumField.kind !== 'enum' || listField.kind !== 'multi-enum' || entity.kind !== 'entity') throw new Error();
        enumField.onChange('b');
        enumField.onChange('a');
        enumField.onChange(undefined);
        expect(onEnum.mock.calls).toEqual([[undefined], ['a'], [undefined]]);
        listField.onChange(['b', 'a']);
        entity.onChange(['a', 'c']);
        expect(onList.mock.calls).toEqual([[['a']], [['a']]]);
        expect(isFieldActive(entity)).toBe(true);
        clearField(entity);
        expect(onList).toHaveBeenLastCalledWith([]);
        expect(selectedOptions(entity).map((option) => option.label)).toEqual(['A']);
    });

    it('match typed text ignoring case and accents', () => {
        expect(matchesQuery('Zdeněk Novák', ' NOVAK ')).toBe(true);
        expect(matchesQuery('Ada', 'max')).toBe(false);
    });
});

describe('placePopover', () => {
    const box = (left: number, top: number, width: number, height: number) => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
    });
    const viewport = { width: 400, height: 600 };

    it('opens below the anchor at its start edge', () => {
        expect(placePopover(box(20, 100, 80, 30), box(0, 0, 200, 150), viewport, false)).toEqual({
            top: 134,
            left: 20,
        });
    });

    it('lines up with the end edge right to left', () => {
        expect(placePopover(box(300, 100, 80, 30), box(0, 0, 200, 150), viewport, true)).toEqual({
            top: 134,
            left: 180,
        });
    });

    it('stays inside the viewport and flips above when there is no room below', () => {
        expect(placePopover(box(350, 500, 40, 30), box(0, 0, 200, 150), viewport, false)).toEqual({
            top: 346,
            left: 192,
        });
        expect(placePopover(box(-20, 10, 40, 30), box(0, 0, 200, 700), viewport, false)).toEqual({ top: 44, left: 8 });
    });
});
