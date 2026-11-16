import { act, renderHook, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { NARROW, setMedia } from '../../testing/dom-gaps';
import { renderUi } from '../../testing/render';
import { createDataTableColumnHelper } from './columns';
import { dataTableGallery } from './data-table.gallery';
import type { DataTableColumnDef } from './columns';
import { FilterBar } from '../filter-bar/filter-bar';
import {
    columnLabel,
    COLUMN_MENU_MIN_ROWS,
    DataTable,
    hasOtherPages,
    initialColumnVisibility,
    narrowLayout,
    SORT_MIN_ROWS,
    tableItems,
    wantsColumnMenu,
    wantsSorting,
} from './data-table';
import type { DataTableProps } from './data-table';
import type { RowSelectionState } from './columns';
import { NARROW_QUERY, useNarrow } from './use-narrow';
import { readColumnVisibility } from './visibility-storage';
import type { DataTableStorage } from './visibility-storage';

interface Agent {
    readonly id: string;
    readonly name: string;
    readonly status: 'active' | 'paused';
    readonly runs: number;
}

const helper = createDataTableColumnHelper<Agent>();
const COLUMNS: DataTableColumnDef<Agent>[] = helper.columns([
    helper.accessor('name', {
        header: 'Name',
        meta: { priority: 1, filter: { kind: 'text', placeholder: 'Search' } },
        enableHiding: false,
    }),
    helper.accessor('status', {
        header: 'Status',
        meta: {
            priority: 2,
            filter: {
                kind: 'select',
                allLabel: 'All statuses',
                options: [
                    { value: 'active', label: 'Active' },
                    { value: 'paused', label: 'Paused' },
                ],
            },
        },
        enableSorting: false,
    }),
    helper.accessor('runs', { header: () => 'Runs', meta: { label: 'Runs' } }),
    helper.accessor('id', { header: 'ID', meta: { hideOnCard: true } }),
]);

// Deliberately not in name order: server-side mode must keep the order the server sent.
const AGENTS: readonly Agent[] = [
    { id: 'grace', name: 'Grace', status: 'paused', runs: 3 },
    { id: 'ada', name: 'Ada', status: 'active', runs: 12 },
    { id: 'linus', name: 'Linus', status: 'active', runs: 7 },
];

// Long enough to earn the column menu without paging.
const MANY_AGENTS: readonly Agent[] = [
    ...AGENTS,
    { id: 'barbara', name: 'Barbara', status: 'active', runs: 1 },
    { id: 'edsger', name: 'Edsger', status: 'paused', runs: 0 },
    { id: 'margaret', name: 'Margaret', status: 'active', runs: 9 },
];

type Props = Partial<DataTableProps<Agent>>;

function table(props: Props = {}): ReactElement {
    return (
        <DataTable<Agent>
            caption="Agents"
            columns={COLUMNS}
            data={AGENTS}
            getRowId={(row) => row.id}
            getRowLabel={(row) => row.name}
            {...props}
        />
    );
}

function bodyRowNames(): string[] {
    const [, ...rows] = screen.getAllByRole('row');
    return rows.map((row) => within(row).queryAllByRole('cell')[0]?.textContent ?? '');
}

function memoryStorage(initial: Record<string, string> = {}): DataTableStorage & { data: Map<string, string> } {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value);
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

/** The screen-reader labels a two-line item gives the values on its meta line. */
function metaLabels(item: HTMLElement): (string | null)[] {
    return [...item.querySelectorAll('.sr-only')].map((label) => label.textContent);
}

describe('DataTable in server-side mode', () => {
    it('is a captioned table with sortable headers as buttons inside th[aria-sort]', () => {
        renderUi(table({ sorting: [{ id: 'runs', desc: true }] }));
        const grid = screen.getByRole('table', { name: 'Agents' });
        expect(grid.querySelector('caption')?.className).toBe('sr-only');
        const name = screen.getByRole('button', { name: 'Sort by Name' });
        expect(name.closest('th')?.getAttribute('aria-sort')).toBe('none');
        const runs = screen.getByRole('button', { name: 'Runs, Sorted descending' });
        expect(runs.closest('th')?.getAttribute('aria-sort')).toBe('descending');
        expect(screen.queryByRole('button', { name: /Status/ })).toBeNull();
        expect(screen.getByRole('columnheader', { name: 'Status' }).hasAttribute('aria-sort')).toBe(false);
    });

    it('emits sorting changes from the keyboard without reordering rows locally', async () => {
        const onSortingChange = vi.fn();
        function Harness() {
            const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
            return table({
                sorting,
                onSortingChange: (next) => {
                    onSortingChange(next);
                    setSorting(next);
                },
            });
        }
        const { user } = renderUi(<Harness />);
        expect(bodyRowNames()).toEqual(['Grace', 'Ada', 'Linus']);

        screen.getByRole('button', { name: 'Sort by Name' }).focus();
        await user.keyboard('{Enter}');
        expect(onSortingChange).toHaveBeenLastCalledWith([{ id: 'name', desc: false }]);
        expect(screen.getByRole('button', { name: 'Name, Sorted ascending' })).toBe(document.activeElement);
        await user.keyboard(' ');
        expect(onSortingChange).toHaveBeenLastCalledWith([{ id: 'name', desc: true }]);
        expect(bodyRowNames()).toEqual(['Grace', 'Ada', 'Linus']);
    });

    it('emits filter changes from its filter controls without filtering rows locally', async () => {
        const onColumnFiltersChange = vi.fn();
        function Harness() {
            const [filters, setFilters] = useState<{ id: string; value: unknown }[]>([]);
            return table({
                columnFilters: filters,
                onColumnFiltersChange: (next) => {
                    onColumnFiltersChange(next);
                    setFilters(next);
                },
            });
        }
        const { user } = renderUi(<Harness />);
        await user.type(screen.getByRole('searchbox', { name: 'Name' }), 'a');
        expect(onColumnFiltersChange).toHaveBeenLastCalledWith([{ id: 'name', value: 'a' }]);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'paused');
        expect(onColumnFiltersChange).toHaveBeenLastCalledWith([
            { id: 'name', value: 'a' },
            { id: 'status', value: 'paused' },
        ]);
        expect(bodyRowNames()).toEqual(['Grace', 'Ada', 'Linus']);

        await user.clear(screen.getByRole('searchbox', { name: 'Name' }));
        expect(onColumnFiltersChange).toHaveBeenLastCalledWith([{ id: 'status', value: 'paused' }]);
    });

    it('toggles column visibility from the columns menu, emitting the change and persisting it per device', async () => {
        const storage = memoryStorage();
        const onColumnVisibilityChange = vi.fn();
        const { user, unmount } = renderUi(
            table({
                data: MANY_AGENTS,
                visibilityStorage: { storage, key: 'agents.columns' },
                onColumnVisibilityChange,
            }),
        );
        await user.click(screen.getByRole('button', { name: 'Columns' }));
        const menu = screen.getByRole('menu', { name: 'Columns' });
        expect(within(menu).queryByRole('menuitemcheckbox', { name: 'Name' })).toBeNull();
        const runs = within(menu).getByRole('menuitemcheckbox', { name: 'Runs' });
        expect(runs.getAttribute('aria-checked')).toBe('true');
        await user.click(runs);

        expect(onColumnVisibilityChange).toHaveBeenLastCalledWith({ runs: false });
        expect(screen.queryByRole('columnheader', { name: /Runs/ })).toBeNull();
        expect(readColumnVisibility(storage, 'agents.columns')).toEqual({ runs: false });

        unmount();
        renderUi(table({ data: AGENTS, visibilityStorage: { storage, key: 'agents.columns' } }));
        expect(screen.queryByRole('columnheader', { name: /Runs/ })).toBeNull();
        // A short list keeps the menu while a column is hidden, so the reader can bring it back.
        expect(screen.getByRole('button', { name: 'Columns' })).toBeDefined();
        expect(screen.getByRole('columnheader', { name: /Name/ })).toBeDefined();
    });

    it('keeps the last visible hideable column and follows controlled visibility', async () => {
        const onColumnVisibilityChange = vi.fn();
        const { user } = renderUi(
            table({ columnVisibility: { status: false, runs: false }, onColumnVisibilityChange }),
        );
        await user.click(screen.getByRole('button', { name: 'Columns' }));
        const id = screen.getByRole('menuitemcheckbox', { name: 'ID' });
        expect(id.getAttribute('aria-disabled')).toBe('true');
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Status' }));
        expect(onColumnVisibilityChange).toHaveBeenLastCalledWith({ status: true, runs: false });
        // Controlled: nothing changes until the owner passes the new state.
        expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
    });

    it('emits row selection changes, selects the page and reports the count', async () => {
        const onRowSelectionChange = vi.fn();
        function Harness() {
            const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
            return table({
                selection: {
                    rowSelection,
                    onRowSelectionChange: (next) => {
                        onRowSelectionChange(next);
                        setRowSelection(next);
                    },
                    canSelect: (row) => row.id !== 'linus',
                },
            });
        }
        const { user } = renderUi(<Harness />);
        await user.click(screen.getByRole('checkbox', { name: 'Select Ada' }));
        expect(onRowSelectionChange).toHaveBeenLastCalledWith({ ada: true });
        expect(screen.getByText('1 selected')).toBeDefined();
        expect(screen.getByRole('checkbox', { name: 'Select Linus' }).hasAttribute('disabled')).toBe(true);
        expect(screen.getByRole('row', { name: /Ada/ }).getAttribute('aria-selected')).toBe('true');

        await user.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
        expect(onRowSelectionChange).toHaveBeenLastCalledWith({ ada: true, grace: true });
        expect(screen.getByText('2 selected')).toBeDefined();
        expect(bodyRowNames()).toEqual(['', '', '']);
    });

    it('emits expansion changes and renders the expanded detail linked to its button', async () => {
        const onExpandedChange = vi.fn();
        function Harness() {
            const [expanded, setExpanded] = useState<Record<string, boolean>>({});
            return table({
                expansion: {
                    expanded,
                    onExpandedChange: (next) => {
                        onExpandedChange(next);
                        setExpanded(next);
                    },
                    renderExpanded: (row) => <p>{`Details of ${row.name}`}</p>,
                    canExpand: (row) => row.id !== 'grace',
                },
            });
        }
        const { user } = renderUi(<Harness />);
        expect(screen.queryByRole('button', { name: 'Expand Grace' })).toBeNull();
        const expand = screen.getByRole('button', { name: 'Expand Ada' });
        expect(expand.getAttribute('aria-expanded')).toBe('false');
        await user.click(expand);
        expect(onExpandedChange).toHaveBeenLastCalledWith({ ada: true });
        const collapse = screen.getByRole('button', { name: 'Collapse Ada' });
        expect(collapse.getAttribute('aria-expanded')).toBe('true');
        const detail = document.getElementById(collapse.getAttribute('aria-controls') ?? '');
        expect(detail?.textContent).toBe('Details of Ada');
        await user.click(collapse);
        expect(onExpandedChange).toHaveBeenLastCalledWith({});
        expect(screen.queryByText('Details of Ada')).toBeNull();
    });

    it('opens row actions as a menu from the keyboard', async () => {
        const archive = vi.fn<(id: string) => void>();
        const { user } = renderUi(
            table({
                rowActions: (row) =>
                    row.id === 'linus'
                        ? []
                        : [
                              {
                                  kind: 'item',
                                  id: 'archive',
                                  label: 'Archive',
                                  onSelect: () => {
                                      archive(row.id);
                                  },
                              },
                              { kind: 'item', id: 'delete', label: 'Delete', tone: 'danger', onSelect: vi.fn() },
                          ],
            }),
        );
        expect(screen.queryByRole('button', { name: 'Actions for Linus' })).toBeNull();
        const trigger = screen.getByRole('button', { name: 'Actions for Ada' });
        trigger.focus();
        await user.keyboard('{ArrowDown}');
        expect(screen.getByRole('menu', { name: 'Actions for Ada' })).toBeDefined();
        expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Archive' }));
        await user.keyboard('{Enter}');
        expect(archive).toHaveBeenCalledWith('ada');
        expect(document.activeElement).toBe(trigger);
    });

    it('pages with the cursors it was given', async () => {
        const onPageChange = vi.fn();
        const { user, rerender } = renderUi(
            table({ page: { previousCursor: 'cursor-1', nextCursor: 'cursor-3', total: 120 }, onPageChange }),
        );
        expect(screen.getByText('120 items')).toBeDefined();
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        expect(onPageChange).toHaveBeenLastCalledWith('cursor-3', 'next');
        await user.click(screen.getByRole('button', { name: 'Previous page' }));
        expect(onPageChange).toHaveBeenLastCalledWith('cursor-1', 'previous');

        rerender(table({ page: { previousCursor: null, nextCursor: 'cursor-2' }, onPageChange }));
        expect(screen.getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(true);
        rerender(table({ page: { previousCursor: null, nextCursor: 'cursor-2' }, onPageChange, fetching: true }));
        expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
    });

    it('shows no paging on a single page', () => {
        const { rerender } = renderUi(
            table({ page: { previousCursor: null, nextCursor: null, total: 3 }, onPageChange: vi.fn() }),
        );
        expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
        expect(screen.queryByText('3 items')).toBeNull();
        rerender(table({ page: { previousCursor: 'cursor-1', nextCursor: null }, onPageChange: vi.fn() }));
        expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeDefined();
    });

    it('offers sort buttons only from a few rows, and keeps them once shown', () => {
        const { rerender } = renderUi(table({ data: AGENTS.slice(0, 2) }));
        expect(screen.queryByRole('button', { name: /^Sort by/ })).toBeNull();
        const name = screen.getByRole('columnheader', { name: 'Name' });
        expect(name.hasAttribute('aria-sort')).toBe(false);
        rerender(table({ data: AGENTS }));
        expect(screen.getByRole('button', { name: 'Sort by Name' }).closest('th')?.getAttribute('aria-sort')).toBe(
            'none',
        );
        rerender(table({ data: AGENTS.slice(0, 1) }));
        expect(screen.getByRole('button', { name: 'Sort by Name' })).toBeDefined();
    });

    it('offers sort buttons on a short list that is sorted or paged', () => {
        const { unmount } = renderUi(table({ data: AGENTS.slice(0, 1), sorting: [{ id: 'runs', desc: true }] }));
        expect(screen.getByRole('button', { name: 'Runs, Sorted descending' })).toBeDefined();
        unmount();
        renderUi(
            table({
                data: AGENTS.slice(0, 1),
                page: { previousCursor: null, nextCursor: 'cursor-2' },
                onPageChange: vi.fn(),
            }),
        );
        expect(screen.getByRole('button', { name: 'Sort by Name' })).toBeDefined();
    });

    it('starts default-hidden columns hidden, with the column menu to bring them back', async () => {
        const storage = memoryStorage();
        const columns: DataTableColumnDef<Agent>[] = [
            helper.accessor('name', { header: 'Name' }),
            helper.accessor('runs', { header: 'Runs', meta: { defaultHidden: true } }),
            helper.display({ id: 'note', header: 'Note', meta: { defaultHidden: true }, cell: () => 'note' }),
            helper.accessor('id', { header: 'ID', meta: { defaultHidden: true }, enableHiding: false }),
        ];
        const { user, unmount } = renderUi(
            table({ columns, data: AGENTS.slice(0, 2), visibilityStorage: { storage, key: 'agents.columns' } }),
        );
        expect(screen.queryByRole('columnheader', { name: 'Runs' })).toBeNull();
        expect(screen.queryByRole('columnheader', { name: 'Note' })).toBeNull();
        // A column that cannot hide cannot start hidden either: the menu could never bring it back.
        expect(screen.getByRole('columnheader', { name: 'ID' })).toBeDefined();
        await user.click(screen.getByRole('button', { name: 'Columns' }));
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Runs' }));
        expect(screen.getByRole('columnheader', { name: 'Runs' })).toBeDefined();
        unmount();

        // The reader's stored choice wins over the default.
        renderUi(table({ columns, data: AGENTS.slice(0, 2), visibilityStorage: { storage, key: 'agents.columns' } }));
        expect(screen.getByRole('columnheader', { name: 'Runs' })).toBeDefined();
        expect(screen.queryByRole('columnheader', { name: 'Note' })).toBeNull();
    });

    it('leaves controlled visibility alone when a column is default-hidden', () => {
        renderUi(
            table({
                columns: [
                    helper.accessor('name', { header: 'Name' }),
                    helper.accessor('runs', { header: 'Runs', meta: { defaultHidden: true } }),
                ],
                columnVisibility: {},
                onColumnVisibilityChange: vi.fn(),
            }),
        );
        expect(screen.getByRole('columnheader', { name: /Runs/ })).toBeDefined();
    });

    it('offers the column menu only on long, paged, filtered or narrowed lists', () => {
        const { rerender } = renderUi(table({ data: AGENTS.slice(0, 2), columnFilters: [] }));
        expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
        rerender(
            table({ data: AGENTS, page: { previousCursor: null, nextCursor: 'cursor-2' }, onPageChange: vi.fn() }),
        );
        expect(screen.getByRole('button', { name: 'Columns' })).toBeDefined();
        // A search outside the table narrows the rows: the menu stays instead of blinking away.
        rerender(table({ data: AGENTS.slice(0, 1) }));
        expect(screen.getByRole('button', { name: 'Columns' })).toBeDefined();
    });

    it('reports the intent to change page on hover and focus, for prefetching', async () => {
        const onPageIntent = vi.fn();
        const { user } = renderUi(
            table({
                page: { previousCursor: 'cursor-1', nextCursor: 'cursor-3' },
                onPageChange: vi.fn(),
                onPageIntent,
            }),
        );
        await user.hover(screen.getByRole('button', { name: 'Next page' }));
        expect(onPageIntent).toHaveBeenLastCalledWith('cursor-3', 'next');
        screen.getByRole('button', { name: 'Previous page' }).focus();
        expect(onPageIntent).toHaveBeenLastCalledWith('cursor-1', 'previous');
    });
});

describe('DataTable states', () => {
    it('shows skeleton rows of stable height while loading and marks itself busy', () => {
        const { container } = renderUi(table({ data: [], loading: true, skeletonRows: 4, rowHeight: 40 }));
        const busy = container.querySelector('[aria-busy="true"]');
        expect(busy?.contains(screen.getByRole('table'))).toBe(true);
        expect(screen.getByRole('status').textContent).toBe('Loading');
        const [, ...rows] = screen.getAllByRole('row');
        expect(rows).toHaveLength(4);
        expect(rows.every((row) => row.style.height === '40px')).toBe(true);
        expect(rows[0]?.querySelectorAll('td')).toHaveLength(4);
    });

    it('keeps the current rows visible and dimmed while the next page loads', () => {
        const { container } = renderUi(table({ fetching: true }));
        expect(bodyRowNames()).toEqual(['Grace', 'Ada', 'Linus']);
        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
        expect(screen.getByRole('table').className).toContain('[filter:var(--data-table-fetching-filter)]');
    });

    it('says when there is nothing yet, or what the app says instead', () => {
        const { rerender } = renderUi(table({ data: [] }));
        expect(screen.getByText('Nothing here yet')).toBeDefined();
        rerender(
            table({
                data: [],
                empty: {
                    title: 'No agents yet',
                    description: 'Create one',
                    icon: <svg data-testid="agents-icon" />,
                    action: <a href="/new">{'New'}</a>,
                },
            }),
        );
        expect(screen.getByText('No agents yet')).toBeDefined();
        expect(screen.getByRole('link', { name: 'New' })).toBeDefined();
        expect(screen.getByTestId('agents-icon').closest('[aria-hidden="true"]')).not.toBeNull();
    });

    it('says no results when filters are active and nothing matches', () => {
        renderUi(table({ data: [], columnFilters: [{ id: 'name', value: 'zz' }] }));
        expect(screen.getByText('No results match your filters')).toBeDefined();
        expect(screen.queryByText('Nothing here yet')).toBeNull();
    });

    it('shows the error state with a retry instead of the rows', async () => {
        const onRetry = vi.fn();
        const { user } = renderUi(
            table({ error: { message: 'The engine did not answer', onRetry, details: 'timeout' } }),
        );
        expect(screen.getByRole('alert').textContent).toContain('The engine did not answer');
        expect(screen.queryByRole('table')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it.each(['light', 'dark'] as const)('has no axe violations with every feature on (%s)', async (theme) => {
        const { container } = renderUi(
            table({
                selection: { rowSelection: { ada: true }, onRowSelectionChange: vi.fn() },
                expansion: {
                    expanded: { ada: true },
                    onExpandedChange: vi.fn(),
                    renderExpanded: () => <p>{'More'}</p>,
                },
                rowActions: () => [{ kind: 'item', id: 'a', label: 'Archive', onSelect: vi.fn() }],
                page: { previousCursor: null, nextCursor: 'n' },
                onPageChange: vi.fn(),
                showCaption: true,
            }),
            { theme },
        );
        await expectNoAxeViolations(container);
    });
});

describe('DataTable horizontal overflow', () => {
    function giveWidths(scrollWidth: number, clientWidth: number) {
        vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
        vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
    }

    it('makes a table wider than its box a focusable region that fades where columns hide', async () => {
        giveWidths(1200, 600);
        const { user } = renderUi(
            table({ columns: [helper.accessor('name', { header: 'Name' }), helper.accessor('id', { header: 'ID' })] }),
        );
        const region = screen.getByRole('region', { name: 'Agents' });
        expect(region.getAttribute('tabindex')).toBe('0');
        expect(region.className).toContain('mask-image:linear-gradient(to_right');
        // The box comes before the sort buttons inside it, so the keyboard can scroll before reaching a column.
        await user.tab();
        expect(document.activeElement).toBe(region);

        region.scrollLeft = 300;
        await act(async () => {
            region.dispatchEvent(new Event('scroll'));
            await Promise.resolve();
        });
        expect(region.className).toContain('mask-image:linear-gradient(to_right,transparent');
        region.scrollLeft = 600;
        await act(async () => {
            region.dispatchEvent(new Event('scroll'));
            await Promise.resolve();
        });
        expect(region.className).toContain('mask-image:linear-gradient(to_left');
    });

    it('keeps a table that fits out of the tab order and unfaded', () => {
        giveWidths(600, 600);
        const { container } = renderUi(table());
        expect(screen.queryByRole('region')).toBeNull();
        expect(container.querySelector('[tabindex="0"]')).toBeNull();
        expect(container.querySelector('[class*="mask-image"]')).toBeNull();
    });
});

describe('DataTable virtualisation', () => {
    const many: Agent[] = Array.from({ length: 10_000 }, (_, index) => ({
        id: `agent-${String(index)}`,
        name: `Agent ${String(index)}`,
        status: index % 2 === 0 ? 'active' : 'paused',
        runs: index,
    }));

    function giveLayout(height: number) {
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1024);
    }

    it('mounts only the visible window of 10,000 rows, with spacers for the rest', async () => {
        giveLayout(480);
        const { container } = renderUi(table({ data: many, rowHeight: 48 }));
        const region = screen.getByRole('region', { name: 'Agents' });
        expect(region.getAttribute('tabindex')).toBe('0');
        const rows = container.querySelectorAll('tbody[data-index] > tr');
        expect(rows.length).toBeGreaterThan(5);
        expect(rows.length).toBeLessThan(40);
        expect(rows[0]?.textContent).toContain('Agent 0');
        const spacer = container.querySelector<HTMLTableCellElement>('tbody[aria-hidden="true"] td');
        expect(Number.parseInt(spacer?.style.height ?? '0', 10)).toBeGreaterThan(400_000);

        region.scrollTop = 48 * 5000;
        await act(async () => {
            region.dispatchEvent(new Event('scroll'));
            await Promise.resolve();
        });
        expect(container.querySelector('tbody[data-index="5000"]')).not.toBeNull();
        expect(container.querySelectorAll('tbody[data-index] > tr').length).toBeLessThan(40);
    });

    it('renders every row below the threshold', () => {
        const { container } = renderUi(table({ data: many.slice(0, 50) }));
        expect(container.querySelectorAll('tbody > tr')).toHaveLength(50);
        expect(screen.queryByRole('region')).toBeNull();
    });
});

describe('DataTable on narrow screens', () => {
    it('renders rows as cards from column metadata, keeping selection, expansion and actions', async () => {
        setMedia(NARROW, true);
        expect(NARROW_QUERY).toBe(NARROW);
        const onRowSelectionChange = vi.fn();
        const { user, container } = renderUi(
            table({
                selection: { rowSelection: {}, onRowSelectionChange },
                expansion: {
                    expanded: { ada: true },
                    onExpandedChange: vi.fn(),
                    renderExpanded: (row) => <p>{`Details of ${row.name}`}</p>,
                },
                rowActions: () => [{ kind: 'item', id: 'a', label: 'Archive', onSelect: vi.fn() }],
            }),
        );
        expect(screen.queryByRole('table')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
        const list = screen.getByRole('list', { name: 'Agents' });
        const cards = within(list).getAllByRole('listitem');
        expect(cards).toHaveLength(3);
        const ada = cards[1];
        if (ada === undefined) throw new Error('no card');
        expect(ada.getAttribute('aria-labelledby')).not.toBeNull();
        expect(document.getElementById(ada.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Ada');
        expect(metaLabels(ada)).toEqual(['Status: ', 'Runs: ']);
        expect(within(ada).getByText('Details of Ada')).toBeDefined();
        expect(within(ada).getByRole('button', { name: 'Actions for Ada' })).toBeDefined();
        await user.click(within(ada).getByRole('checkbox', { name: 'Select Ada' }));
        expect(onRowSelectionChange).toHaveBeenCalledWith({ ada: true });
        await expectNoAxeViolations(container);
    });

    it('switches live between table and cards, and shows card skeletons and empty states', () => {
        const { rerender } = renderUi(table());
        expect(screen.getByRole('table')).toBeDefined();
        act(() => {
            setMedia(NARROW, true);
        });
        expect(screen.queryByRole('table')).toBeNull();
        rerender(table({ data: [], loading: true }));
        expect(within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem')).toHaveLength(5);
        rerender(table({ data: [] }));
        expect(screen.getByText('Nothing here yet')).toBeDefined();
        rerender(table({ fetching: true, selection: { rowSelection: { ada: true }, onRowSelectionChange: vi.fn() } }));
        const list = screen.getByRole('list', { name: 'Agents' });
        expect(list.parentElement?.getAttribute('aria-busy')).toBe('true');
        expect(list.parentElement?.className).toContain('[filter:var(--data-table-fetching-filter)]');
        expect(within(list).getByRole('checkbox', { name: 'Select Ada' })).toHaveProperty('checked', true);
    });

    it('virtualises long card lists too', async () => {
        setMedia(NARROW, true);
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
        const many = Array.from({ length: 1000 }, (_, index) => ({
            id: String(index),
            name: `Agent ${String(index)}`,
            status: 'active' as const,
            runs: index,
        }));
        renderUi(table({ data: many, rowHeight: 120 }));
        const list = screen.getByRole('list', { name: 'Agents' });
        expect(within(list).getAllByRole('listitem').length).toBeLessThan(30);

        const scroller = list.parentElement;
        if (scroller === null) throw new Error('no scroll container');
        scroller.scrollTop = 120 * 500;
        await act(async () => {
            scroller.dispatchEvent(new Event('scroll'));
            await Promise.resolve();
        });
        expect(within(list).getByText('Agent 500')).toBeDefined();
        expect(list.querySelector('li[aria-hidden="true"]')).not.toBeNull();
    });

    it('titles a card by its row label when no column is shown on cards, and orders unprioritised columns as defined', () => {
        setMedia(NARROW, true);
        const { rerender } = renderUi(
            <DataTable<Agent>
                caption="Agents"
                columns={[helper.accessor('id', { header: 'ID', meta: { hideOnCard: true } })]}
                data={AGENTS}
                getRowId={(row) => row.id}
                getRowLabel={(row) => `Agent ${row.name}`}
            />,
        );
        const [first] = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem');
        expect(first?.textContent).toBe('Agent Grace');

        rerender(
            <DataTable<Agent>
                caption="Agents"
                columns={[
                    helper.accessor('status', { header: 'Status' }),
                    helper.accessor('runs', { header: 'Runs' }),
                    helper.accessor('name', { header: 'Name', meta: { priority: 0 } }),
                ]}
                data={AGENTS}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.name}
            />,
        );
        const [card] = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem');
        expect(metaLabels(card ?? document.body)).toEqual(['Status: ', 'Runs: ']);
    });
});

describe('DataTable in client-side mode', () => {
    it('sorts and filters the loaded rows itself', async () => {
        const { user } = renderUi(table({ mode: 'client' }));
        await user.click(screen.getByRole('button', { name: 'Sort by Name' }));
        expect(bodyRowNames()).toEqual(['Ada', 'Grace', 'Linus']);
        await user.type(screen.getByRole('searchbox', { name: 'Name' }), 'li');
        expect(bodyRowNames()).toEqual(['Linus']);
        await user.type(screen.getByRole('searchbox', { name: 'Name' }), 'zz');
        expect(screen.getByText('No results match your filters')).toBeDefined();
    });
});

describe('DataTable controls', () => {
    const short = {
        hideableColumns: 3,
        hiddenColumns: 0,
        rows: COLUMN_MENU_MIN_ROWS - 1,
        paged: false,
        filtered: false,
    };

    it('want a column menu only when a column can hide and the list is long, paged, filtered or narrowed', () => {
        expect(wantsColumnMenu(short)).toBe(false);
        expect(wantsColumnMenu({ ...short, rows: COLUMN_MENU_MIN_ROWS })).toBe(true);
        expect(wantsColumnMenu({ ...short, paged: true })).toBe(true);
        expect(wantsColumnMenu({ ...short, filtered: true })).toBe(true);
        expect(wantsColumnMenu({ ...short, hiddenColumns: 1 })).toBe(true);
        expect(wantsColumnMenu({ ...short, hideableColumns: 0, rows: 500, paged: true })).toBe(false);
    });

    it('want sort buttons only when a column sorts and the list has a few rows, pages, a sort or a filter', () => {
        const few = { sortableColumns: 2, rows: SORT_MIN_ROWS - 1, paged: false, sorted: false, filtered: false };
        expect(SORT_MIN_ROWS).toBe(3);
        expect(wantsSorting(few)).toBe(false);
        expect(wantsSorting({ ...few, rows: SORT_MIN_ROWS })).toBe(true);
        expect(wantsSorting({ ...few, paged: true })).toBe(true);
        expect(wantsSorting({ ...few, sorted: true })).toBe(true);
        expect(wantsSorting({ ...few, filtered: true })).toBe(true);
        expect(wantsSorting({ ...few, sortableColumns: 0, rows: 500, paged: true, sorted: true })).toBe(false);
    });

    it('merge default-hidden columns under the stored visibility', () => {
        const columns: DataTableColumnDef<Agent>[] = [
            helper.accessor('name', { header: 'Name' }),
            helper.accessor('runs', { header: 'Runs', meta: { defaultHidden: true } }),
            helper.display({ id: 'note', header: 'Note', meta: { defaultHidden: true } }),
        ];
        expect(initialColumnVisibility(columns, {})).toEqual({ runs: false, note: false });
        expect(initialColumnVisibility(columns, { runs: true, name: false })).toEqual({
            runs: true,
            note: false,
            name: false,
        });
        expect(initialColumnVisibility([], {})).toEqual({});
    });

    it('page only when another page exists', () => {
        expect(hasOtherPages(undefined)).toBe(false);
        expect(hasOtherPages({ previousCursor: null, nextCursor: null })).toBe(false);
        expect(hasOtherPages({ previousCursor: 'a', nextCursor: null })).toBe(true);
        expect(hasOtherPages({ previousCursor: null, nextCursor: 'b' })).toBe(true);
    });
});

describe('column helpers', () => {
    it('label a column by meta, then a string header, then its id', () => {
        const columns = new Map<string, string>();
        function Probe() {
            return (
                <DataTable<Agent>
                    caption="Probe"
                    columns={[
                        helper.accessor('name', { header: 'Name', meta: { filter: { kind: 'text' } } }),
                        helper.accessor('runs', { header: () => 'Runs' }),
                        helper.accessor('status', { header: () => 'Status', meta: { label: 'State' } }),
                    ]}
                    data={AGENTS}
                    getRowId={(row) => row.id}
                    getRowLabel={(row) => row.name}
                    rowActions={() => []}
                    visibilityStorage={{
                        storage: {
                            getItem: () => {
                                throw new DOMException('denied', 'SecurityError');
                            },
                            setItem: () => {
                                throw new DOMException('denied', 'SecurityError');
                            },
                        },
                        key: 'k',
                    }}
                />
            );
        }
        renderUi(<Probe />);
        for (const button of screen.getAllByRole('button', { name: /^Sort by/ })) {
            columns.set(button.getAttribute('aria-label') ?? '', '');
        }
        expect([...columns.keys()]).toEqual(['Sort by Name', 'Sort by runs', 'Sort by State']);
        expect(typeof columnLabel).toBe('function');
    });

    it('treat malformed stored visibility as all visible', () => {
        expect(readColumnVisibility(memoryStorage({ k: 'not json' }), 'k')).toEqual({});
        expect(readColumnVisibility(memoryStorage({ k: '[1]' }), 'k')).toEqual({});
        expect(readColumnVisibility(memoryStorage({ k: '{"a":false,"b":"x"}' }), 'k')).toEqual({ a: false });
        expect(readColumnVisibility(undefined, 'k')).toEqual({});
    });
});

describe('useNarrow', () => {
    it('answers wide where matchMedia is missing', () => {
        const descriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
        Reflect.deleteProperty(window, 'matchMedia');
        try {
            expect(renderHook(() => useNarrow()).result.current).toBe(false);
        } finally {
            if (descriptor !== undefined) Object.defineProperty(window, 'matchMedia', descriptor);
        }
    });
});

describe('dataTableGallery', () => {
    it('renders every state, and its server-side example sorts, filters and pages through callbacks', async () => {
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(480);
        const { user } = renderUi(dataTableGallery.render() as ReactElement);
        for (const name of [
            'Agents (server-side)',
            'Loading',
            'Refreshing',
            'Empty',
            'No results',
            '10,000 agents (virtualised, client-side)',
        ]) {
            expect(screen.getByRole('table', { name })).toBeDefined();
        }
        const server = screen.getByRole('table', { name: 'Agents (server-side)' });
        await user.click(within(server).getByRole('button', { name: 'Sort by Runs' }));
        expect(within(server).getByRole('button', { name: /^Runs, Sorted/ })).toBeDefined();
        await user.click(screen.getAllByRole('button', { name: 'Next page' })[0] as HTMLElement);
        expect(screen.getAllByText('23 items')).toHaveLength(1);
    });
});

describe('DataTable rich rows', () => {
    const RICH: DataTableColumnDef<Agent>[] = helper.columns([
        helper.accessor('name', {
            header: 'Name',
            enableHiding: false,
            meta: { priority: 0, icon: <svg data-testid="name-icon" /> },
        }),
        helper.accessor('status', { header: 'Status', enableSorting: false, meta: { priority: 1 } }),
        helper.accessor('runs', { header: 'Runs', meta: { priority: 2, numeric: true, trailing: true } }),
        helper.accessor('id', { header: 'ID', enableSorting: false, meta: { defaultHidden: true } }),
    ]);
    const GROUPS = {
        groups: [
            { id: 'active', label: 'Now' },
            { id: 'later', label: 'Coming up' },
            { id: 'paused', label: 'Done' },
        ],
        getGroupId: (row: Agent) => row.status,
    };

    it.each(['light', 'dark'] as const)(
        'puts a quiet icon before a header and lines numbers up in tabular figures (%s)',
        async (theme) => {
            const { container } = renderUi(table({ columns: RICH, rowActions: () => [] }), { theme });
            const name = screen.getByRole('columnheader', { name: 'Name' });
            expect(within(name).getByTestId('name-icon').parentElement?.getAttribute('aria-hidden')).toBe('true');
            const runs = screen.getByRole('columnheader', { name: /Runs/ });
            expect(runs.className).toContain('text-end');
            const [, ada] = screen.getAllByRole('row');
            const cells = within(ada ?? document.body).getAllByRole('cell');
            expect(cells[2]?.className).toContain('tabular-nums');
            // An empty menu is no menu.
            expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
            await expectNoAxeViolations(container);
        },
    );

    it('groups rows under headers with counts, leaving out empty groups', async () => {
        const { container } = renderUi(table({ columns: RICH, groups: GROUPS }));
        const headers = screen.getAllByRole('rowheader').map((header) => header.textContent);
        expect(headers).toEqual(['Now2', 'Done1']);
        expect(screen.getAllByRole('rowheader')[0]?.getAttribute('scope')).toBe('rowgroup');
        expect(bodyRowNames()).toEqual(['', 'Ada', 'Linus', '', 'Grace']);
        await expectNoAxeViolations(container);
    });

    it('groups two-line items on a narrow screen too', () => {
        setMedia(NARROW, true);
        renderUi(table({ columns: RICH, groups: GROUPS }));
        const items = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem');
        expect(items.map((item) => item.textContent)).toEqual([
            'Now2',
            'AdaRuns: 12Status: active',
            'LinusRuns: 7Status: active',
            'Done1',
            'GraceRuns: 3Status: paused',
        ]);
    });

    it('flattens rows and groups for virtualisation, and splits a narrow row by priority', () => {
        const rows = AGENTS.map((agent) => ({ id: agent.id, original: agent }));
        // Only `id` and `original` are read here; the full row type is TanStack Table's.
        const items = tableItems(rows as never, GROUPS);
        expect(
            items.map((item) => (item.kind === 'group' ? `#${item.id}:${String(item.count)}` : item.row.id)),
        ).toEqual(['#active:2', 'ada', 'linus', '#paused:1', 'grace']);
        expect(tableItems(rows as never, undefined)).toHaveLength(3);
        expect(narrowLayout([]).title).toBeUndefined();
    });

    it('hands its toolbar the sort and the columns, so a FilterBar mirrors the headers', async () => {
        const onSortingChange = vi.fn();
        const { user, rerender } = renderUi(
            table({
                columns: RICH,
                sorting: [{ id: 'runs', desc: true }],
                onSortingChange,
                toolbar: (view) => <FilterBar {...view} />,
            }),
        );
        expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Sorted by Runs, Sorted descending' }));
        expect(screen.getByRole('menuitemradio', { name: 'Name' }).getAttribute('aria-checked')).toBe('false');
        await user.click(screen.getByRole('menuitemradio', { name: 'Name' }));
        expect(onSortingChange).toHaveBeenLastCalledWith([{ id: 'name', desc: true }]);

        await user.click(screen.getByRole('button', { name: 'View options' }));
        expect(screen.getByRole('menuitemcheckbox', { name: 'ID' }).getAttribute('aria-checked')).toBe('false');
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'ID' }));
        expect(screen.getByRole('columnheader', { name: 'ID' })).toBeDefined();
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'Status' }));
        await user.click(screen.getByRole('menuitemcheckbox', { name: 'ID' }));
        expect(screen.getByRole('menuitemcheckbox', { name: 'Runs' }).getAttribute('aria-disabled')).toBe('true');

        rerender(table({ columns: RICH, toolbar: (view) => <FilterBar {...view} /> }));
        act(() => {
            setMedia(NARROW, true);
        });
        expect(screen.queryByRole('button', { name: 'View options' })).toBeNull();
    });

    it('flips a sorted header instead of clearing it when the list always has an order', async () => {
        const onSortingChange = vi.fn();
        const { user } = renderUi(
            table({ columns: RICH, sorting: [{ id: 'runs', desc: true }], onSortingChange, sortingRemoval: false }),
        );
        await user.click(screen.getByRole('button', { name: 'Runs, Sorted descending' }));
        expect(onSortingChange).toHaveBeenLastCalledWith([{ id: 'runs', desc: false }]);
    });

    it('reveals row actions on hover with a mouse, yet keeps them in the tab order', async () => {
        const { user } = renderUi(
            table({
                rowActions: (row) => [{ kind: 'item', id: 'a', label: `Archive ${row.name}`, onSelect: vi.fn() }],
            }),
        );
        const trigger = screen.getByRole('button', { name: 'Actions for Ada' });
        expect(trigger.className).toContain('pointer-fine:opacity-0');
        expect(trigger.className).toContain('group-focus-within/row:opacity-100');
        expect(trigger.closest('tr')?.className).toContain('group/row');
        trigger.focus();
        await user.keyboard('{Enter}');
        expect(screen.getByRole('menuitem', { name: 'Archive Ada' })).toBeDefined();
    });
});
