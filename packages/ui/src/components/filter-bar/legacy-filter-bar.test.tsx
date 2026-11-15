import { act, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { NARROW, setMedia } from '../../testing/dom-gaps';
import { renderUi } from '../../testing/render';
import { LegacyFilterBar } from './legacy-filter-bar';
import type { LegacyFilterBarProps } from './legacy-filter-bar';

const STATUSES = [
    { value: 'working', label: 'Working' },
    { value: 'idle', label: 'Idle' },
    { value: 'failed', label: 'Failed' },
];
const AGENTS = [
    { value: 'ada', label: 'Ada' },
    { value: 'grace', label: 'Grace' },
];

interface State {
    readonly q: string;
    readonly status: readonly string[];
    readonly agent: string | undefined;
    readonly from: string | undefined;
    readonly target: string;
}
const NONE: State = { q: '', status: [], agent: undefined, from: undefined, target: '' };

const seen: { state: State } = { state: NONE };
function Harness({ initial = NONE, empty = false }: { readonly initial?: State; readonly empty?: boolean }) {
    const [state, setState] = useState(initial);
    useEffect(() => {
        seen.state = state;
    });
    const set = (patch: Partial<State>) => {
        setState((current) => ({ ...current, ...patch }));
    };
    const props: LegacyFilterBarProps = {
        empty,
        search: {
            label: 'Search runs',
            value: state.q,
            onChange: (q) => {
                set({ q });
            },
        },
        filters: [
            {
                kind: 'multi',
                id: 'status',
                label: 'Status',
                options: STATUSES,
                value: state.status,
                onChange: (status) => {
                    set({ status });
                },
            },
            {
                kind: 'select',
                id: 'agent',
                label: 'Agent',
                allLabel: 'All agents',
                options: AGENTS,
                value: state.agent,
                onChange: (agent) => {
                    set({ agent });
                },
            },
            {
                kind: 'date',
                id: 'from',
                label: 'From',
                hint: 'Days in Europe/Prague',
                value: state.from,
                onChange: (from) => {
                    set({ from });
                },
            },
            {
                kind: 'text',
                id: 'target',
                label: 'Target',
                value: state.target,
                onChange: (target) => {
                    set({ target });
                },
            },
        ],
        onClear: () => {
            setState(NONE);
        },
    };
    return <LegacyFilterBar {...props} />;
}

afterEach(() => {
    seen.state = NONE;
});

describe('LegacyFilterBar on a wide screen', () => {
    it.each(['light', 'dark'] as const)('is one named search row of compact controls (%s)', async (theme) => {
        const { container } = renderUi(<Harness />, { theme });
        const bar = screen.getByRole('search', { name: 'Filters' });
        expect(within(bar).getByRole('searchbox', { name: 'Search runs' })).toBeDefined();
        expect(within(bar).getByRole('button', { name: 'Status' }).getAttribute('aria-haspopup')).toBe('menu');
        expect(within(bar).getByRole('combobox', { name: 'Agent' })).toBeDefined();
        expect(within(bar).getByLabelText('From')).toBeDefined();
        expect(within(bar).getByRole('searchbox', { name: 'Target' })).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Filters' })).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('toggles statuses in a menu that stays open and counts them on the trigger', async () => {
        const { user } = renderUi(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Status' }));
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Working' }));
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Failed' }));
        expect(seen.state.status).toEqual(['working', 'failed']);
        expect(screen.getByRole('menuitemcheckbox', { name: 'Working' }).getAttribute('aria-checked')).toBe('true');
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Working' }));
        expect(seen.state.status).toEqual(['failed']);
        await user.keyboard('{Escape}');
        expect(screen.getByRole('button', { name: /^Status\s*1 selected$/ })).toBeDefined();
    });

    it('picks one agent or all from a compact select', async () => {
        const { user } = renderUi(<Harness />);
        const agent = screen.getByRole('combobox', { name: 'Agent' });
        expect((agent as HTMLSelectElement).value).toBe('');
        await user.selectOptions(agent, 'grace');
        expect(seen.state.agent).toBe('grace');
        await user.selectOptions(agent, 'All agents');
        expect(seen.state.agent).toBeUndefined();
    });

    it('takes a date and text, and clears everything at once', async () => {
        const { user } = renderUi(<Harness />);
        await user.type(screen.getByLabelText('From'), '2026-10-01');
        expect(seen.state.from).toBe('2026-10-01');
        await user.type(screen.getByRole('searchbox', { name: 'Target' }), 'agt');
        await user.type(screen.getByRole('searchbox', { name: 'Search runs' }), 'report');
        expect(seen.state).toMatchObject({ target: 'agt', q: 'report' });
        await user.clear(screen.getByLabelText('From'));
        expect(seen.state.from).toBeUndefined();
        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(seen.state).toEqual(NONE);
        expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    });

    it('renders nothing for an empty, unfiltered list, but stays while a search or filter emptied it', () => {
        const { rerender } = renderUi(<Harness empty />);
        expect(screen.queryByRole('search')).toBeNull();
        rerender(<Harness empty initial={{ ...NONE, q: 'zzz' }} key="searched" />);
        expect(screen.getByRole('search')).toBeDefined();
        rerender(<Harness empty initial={{ ...NONE, status: ['idle'] }} key="filtered" />);
        expect(screen.getByRole('search')).toBeDefined();
    });
});

describe('LegacyFilterBar on a phone', () => {
    it.each(['light', 'dark'] as const)(
        'keeps the search and collapses the filters behind a counted button (%s)',
        async (theme) => {
            setMedia(NARROW, true);
            const { container } = renderUi(
                <Harness initial={{ ...NONE, status: ['idle', 'failed'], agent: 'ada' }} />,
                {
                    theme,
                },
            );
            expect(screen.getByRole('searchbox', { name: 'Search runs' })).toBeDefined();
            expect(screen.queryByRole('button', { name: /^Status/ })).toBeNull();
            const open = screen.getByRole('button', { name: /^Filters\s*2 active$/ });
            expect(open.textContent).toContain('2');
            expect(screen.getAllByRole('button', { name: /^Remove / }).map((chip) => chip.textContent)).toEqual([
                'Status: Idle',
                'Status: Failed',
                'Agent: Ada',
            ]);
            await expectNoAxeViolations(container);
        },
    );

    it('removes one value from its chip', async () => {
        setMedia(NARROW, true);
        const { user } = renderUi(<Harness initial={{ ...NONE, status: ['idle', 'failed'], from: '2026-10-01' }} />);
        await user.click(screen.getByRole('button', { name: 'Remove Status: Idle' }));
        expect(seen.state.status).toEqual(['failed']);
        await user.click(screen.getByRole('button', { name: 'Remove From: 2026-10-01' }));
        expect(seen.state.from).toBeUndefined();
    });

    it('edits every filter in the sheet, then shows the results', async () => {
        setMedia(NARROW, true);
        const { user } = renderUi(<Harness />);
        await user.click(screen.getByRole('button', { name: /^Filters/ }));
        const sheet = screen.getByRole('dialog', { name: 'Filters' });
        const status = within(sheet).getByRole('group', { name: 'Status' });
        await user.click(within(status).getByRole('checkbox', { name: 'Failed' }));
        await user.click(within(status).getByRole('checkbox', { name: 'Idle' }));
        await user.click(within(status).getByRole('checkbox', { name: 'Failed' }));
        expect(seen.state.status).toEqual(['idle']);
        await user.selectOptions(within(sheet).getByRole('combobox', { name: 'Agent' }), 'grace');
        expect(seen.state.agent).toBe('grace');
        await user.selectOptions(within(sheet).getByRole('combobox', { name: 'Agent' }), 'All agents');
        expect(seen.state.agent).toBeUndefined();
        await user.type(within(sheet).getByLabelText('From'), '2026-10-02');
        await user.clear(within(sheet).getByLabelText('From'));
        expect(seen.state.from).toBeUndefined();
        await user.type(within(sheet).getByRole('searchbox', { name: 'Target' }), 'x');
        expect(seen.state.target).toBe('x');
        expect(within(sheet).getByText('Days in Europe/Prague')).toBeDefined();
        await expectNoAxeViolations(sheet);

        await user.click(within(sheet).getByRole('button', { name: 'Clear filters' }));
        expect(seen.state).toEqual(NONE);
        await user.click(within(sheet).getByRole('button', { name: 'Show results' }));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('offers no Filters button when there is only a search', () => {
        setMedia(NARROW, true);
        const onClear = vi.fn();
        renderUi(
            <LegacyFilterBar
                search={{ label: 'Search', value: '', onChange: vi.fn() }}
                filters={[]}
                onClear={onClear}
            />,
        );
        expect(screen.queryByRole('button', { name: 'Filters' })).toBeNull();
        act(() => {
            setMedia(NARROW, false);
        });
        expect(screen.getByRole('searchbox', { name: 'Search' })).toBeDefined();
    });
});
