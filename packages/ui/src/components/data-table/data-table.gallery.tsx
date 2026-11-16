import { Bot } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Badge } from '../badge/badge';
import { RunsListDemo } from '../filter-bar/filter-bar.gallery';
import { createDataTableColumnHelper } from './columns';
import type { ColumnFiltersState, DataTableColumnDef, RowSelectionState, SortingState } from './columns';
import { DataTable } from './data-table';

interface SampleAgent {
    readonly id: string;
    readonly name: string;
    readonly status: 'active' | 'paused';
    readonly runs: number;
}

const NAMES = ['Ada', 'Grace', 'Linus', 'Margaret', 'Alan', 'Barbara', 'Dennis', 'Ken', 'Radia', 'Frances'];
const AGENTS: readonly SampleAgent[] = Array.from({ length: 23 }, (_, index) => ({
    id: `agent-${String(index)}`,
    name: `${NAMES[index % NAMES.length] ?? 'Agent'} bot ${String(index + 1)}`,
    status: index % 3 === 0 ? 'paused' : 'active',
    runs: (index * 37) % 101,
}));
const MANY: readonly SampleAgent[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `many-${String(index)}`,
    name: `Agent ${String(index + 1)}`,
    status: index % 2 === 0 ? 'active' : 'paused',
    runs: index % 250,
}));
const NONE: readonly SampleAgent[] = [];
const PAGE_SIZE = 8;

const helper = createDataTableColumnHelper<SampleAgent>();
const COLUMNS: DataTableColumnDef<SampleAgent>[] = helper.columns([
    helper.accessor('name', {
        header: 'Name',
        enableHiding: false,
        meta: { priority: 0, filter: { kind: 'text', placeholder: 'Search agents' } },
    }),
    helper.accessor('status', {
        header: 'Status',
        enableSorting: false,
        cell: (context) => (
            <Badge tone={context.getValue() === 'active' ? 'success' : 'neutral'}>{context.getValue()}</Badge>
        ),
        meta: {
            priority: 1,
            filter: {
                kind: 'select',
                allLabel: 'All statuses',
                options: [
                    { value: 'active', label: 'Active' },
                    { value: 'paused', label: 'Paused' },
                ],
            },
        },
    }),
    helper.accessor('runs', { header: 'Runs', meta: { priority: 2 } }),
    helper.accessor('id', { header: 'ID', meta: { hideOnCard: true } }),
]);

/** Stands in for the engine: filters, sorts and pages on the "server", so the table only renders what it gets. */
function serverPage(sorting: SortingState, filters: ColumnFiltersState, offset: number) {
    const name = filters.find((filter) => filter.id === 'name')?.value;
    const status = filters.find((filter) => filter.id === 'status')?.value;
    const matching = AGENTS.filter(
        (agent) =>
            (typeof name !== 'string' || agent.name.toLowerCase().includes(name.toLowerCase())) &&
            (typeof status !== 'string' || agent.status === status),
    );
    const [sort] = sorting;
    const sorted =
        sort === undefined
            ? matching
            : matching.toSorted((a, b) => {
                  const order = sort.id === 'runs' ? a.runs - b.runs : a.name.localeCompare(b.name);
                  return sort.desc ? -order : order;
              });
    return {
        rows: sorted.slice(offset, offset + PAGE_SIZE),
        previousCursor: offset > 0 ? String(Math.max(0, offset - PAGE_SIZE)) : null,
        nextCursor: offset + PAGE_SIZE < sorted.length ? String(offset + PAGE_SIZE) : null,
        total: sorted.length,
    };
}

function ServerSideExample() {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [filters, setFilters] = useState<ColumnFiltersState>([]);
    const [offset, setOffset] = useState(0);
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const page = useMemo(() => serverPage(sorting, filters, offset), [sorting, filters, offset]);
    return (
        <DataTable<SampleAgent>
            caption="Agents (server-side)"
            showCaption
            columns={COLUMNS}
            data={page.rows}
            getRowId={(row) => row.id}
            getRowLabel={(row) => row.name}
            sorting={sorting}
            onSortingChange={(next) => {
                setSorting(next);
                setOffset(0);
            }}
            columnFilters={filters}
            onColumnFiltersChange={(next) => {
                setFilters(next);
                setOffset(0);
            }}
            page={{ previousCursor: page.previousCursor, nextCursor: page.nextCursor, total: page.total }}
            onPageChange={(cursor) => {
                setOffset(Number(cursor));
            }}
            selection={{ rowSelection, onRowSelectionChange: setRowSelection }}
            expansion={{
                expanded,
                onExpandedChange: setExpanded,
                renderExpanded: (row) => <p className="text-sm">{`${row.name} has run ${String(row.runs)} times.`}</p>,
            }}
            rowActions={(row) => [
                { kind: 'item', id: 'run', label: `Run ${row.name}`, onSelect: () => undefined },
                { kind: 'separator', id: 'separator' },
                { kind: 'item', id: 'delete', label: 'Delete', tone: 'danger', onSelect: () => undefined },
            ]}
        />
    );
}

const noop = (): void => undefined;

export const dataTableGallery: GalleryEntry = {
    id: 'data-table',
    title: 'DataTable',
    render: () => (
        <div className="flex flex-col gap-8">
            <RunsListDemo />
            <ServerSideExample />
            <DataTable<SampleAgent>
                caption="Loading"
                showCaption
                columns={COLUMNS}
                data={NONE}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.name}
                loading
                skeletonRows={3}
            />
            <DataTable<SampleAgent>
                caption="Refreshing"
                showCaption
                columns={COLUMNS}
                data={AGENTS.slice(0, 3)}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.name}
                fetching
            />
            <DataTable<SampleAgent>
                caption="Empty"
                showCaption
                columns={COLUMNS}
                data={NONE}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.name}
                empty={{ icon: <Bot />, title: 'No agents yet', description: 'Agents you create appear here.' }}
            />
            <DataTable<SampleAgent>
                caption="No results"
                showCaption
                columns={COLUMNS}
                data={NONE}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.name}
                columnFilters={[{ id: 'name', value: 'zzz' }]}
                onColumnFiltersChange={noop}
            />
            <DataTable<SampleAgent>
                caption="Error"
                showCaption
                columns={COLUMNS}
                data={NONE}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.name}
                error={{ message: 'The engine did not answer in time.', onRetry: noop, details: 'timeout after 30 s' }}
            />
            <DataTable<SampleAgent>
                caption="10,000 agents (virtualised, client-side)"
                showCaption
                mode="client"
                columns={COLUMNS}
                data={MANY}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.name}
            />
        </div>
    ),
};
