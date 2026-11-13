import { Bot, CalendarClock, CircleDot, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Avatar } from '../avatar/avatar';
import type { SortingState } from '../data-table/columns';
import { DataTable } from '../data-table/data-table';
import {
    SAMPLE_AGENTS,
    SAMPLE_GROUPS,
    SAMPLE_RUN_COLUMNS,
    SAMPLE_RUNS,
    SOURCE_LABELS,
    STATUS_LABELS,
    STATUS_TONES,
    sampleGroupOf,
} from '../data-table/sample-runs.gallery';
import type { SampleRun, SampleRunStatus, SampleSource } from '../data-table/sample-runs.gallery';
import { StatusDot } from '../status/status';
import { FilterBar, filterField } from './filter-bar';
import type { FilterBarDateRange, FilterBarField } from './filter-bar';

const STATUSES = Object.keys(STATUS_LABELS) as SampleRunStatus[];
const SOURCES = Object.keys(SOURCE_LABELS) as SampleSource[];

interface RunView {
    readonly q: string;
    readonly status: readonly SampleRunStatus[];
    readonly agent: readonly string[];
    readonly source: SampleSource | undefined;
    readonly queued: FilterBarDateRange;
}

const NO_VIEW: RunView = {
    q: '',
    status: [],
    agent: [],
    source: undefined,
    queued: { from: undefined, to: undefined },
};

function runFields(view: RunView, set: (patch: Partial<RunView>) => void): readonly FilterBarField[] {
    return [
        filterField.multiEnum<SampleRunStatus>({
            id: 'status',
            label: 'Status',
            icon: <CircleDot className="size-3.5" />,
            options: STATUSES.map((status) => ({
                value: status,
                label: STATUS_LABELS[status],
                icon: <StatusDot tone={STATUS_TONES[status]} />,
            })),
            value: view.status,
            onChange: (status) => {
                set({ status });
            },
        }),
        filterField.entity({
            id: 'agent',
            label: 'Agent',
            icon: <Bot className="size-3.5" />,
            options: SAMPLE_AGENTS.map((agent) => ({
                value: agent.id,
                label: agent.name,
                icon: <Avatar name={agent.name} tint={agent.tint} size="2xs" />,
            })),
            value: view.agent,
            onChange: (agent) => {
                set({ agent });
            },
        }),
        filterField.enum<SampleSource>({
            id: 'source',
            label: 'Source',
            icon: <Zap className="size-3.5" />,
            options: SOURCES.map((source) => ({ value: source, label: SOURCE_LABELS[source] })),
            value: view.source,
            onChange: (source) => {
                set({ source });
            },
        }),
        filterField.dateRange({
            id: 'queued',
            label: 'Queued',
            icon: <CalendarClock className="size-3.5" />,
            hint: 'Days in Europe/Prague',
            value: view.queued,
            onChange: (queued) => {
                set({ queued });
            },
        }),
    ];
}

function matches(run: SampleRun, view: RunView): boolean {
    const day = run.queuedAt.toISOString().slice(0, 10);
    return (
        (view.q === '' || run.title.toLowerCase().includes(view.q.toLowerCase())) &&
        (view.status.length === 0 || view.status.includes(run.status)) &&
        (view.agent.length === 0 || view.agent.includes(run.agent.id)) &&
        (view.source === undefined || view.source === run.source) &&
        (view.queued.from === undefined || day >= view.queued.from) &&
        (view.queued.to === undefined || day <= view.queued.to)
    );
}

/** A runs list as a screen builds it: the bar in the table's toolbar, so Sort and Columns sit in the bar. */
export function RunsListDemo({
    initial = NO_VIEW,
    grouped = true,
}: {
    readonly initial?: RunView;
    readonly grouped?: boolean;
}) {
    const [view, setView] = useState(initial);
    const [sorting, setSorting] = useState<SortingState>([{ id: 'queuedAt', desc: true }]);
    const set = (patch: Partial<RunView>) => {
        setView((current) => ({ ...current, ...patch }));
    };
    const rows = useMemo(() => SAMPLE_RUNS.filter((run) => matches(run, view)), [view]);
    return (
        <DataTable<SampleRun>
            caption="Runs"
            mode="client"
            columns={SAMPLE_RUN_COLUMNS}
            data={rows}
            getRowId={(run) => run.id}
            getRowLabel={(run) => run.title}
            sorting={sorting}
            onSortingChange={setSorting}
            sortingRemoval={false}
            {...(grouped ? { groups: { groups: SAMPLE_GROUPS, getGroupId: sampleGroupOf } } : {})}
            rowActions={(run) => [
                { kind: 'item', id: 'open', label: `Open ${run.title}`, onSelect: () => undefined },
                { kind: 'item', id: 'retry', label: 'Retry', onSelect: () => undefined },
                { kind: 'separator', id: 'separator' },
                { kind: 'item', id: 'stop', label: 'Stop', tone: 'danger', onSelect: () => undefined },
            ]}
            toolbar={(table) => (
                <FilterBar
                    {...table}
                    label="Filter runs"
                    search={{
                        label: 'Search runs',
                        value: view.q,
                        onChange: (q) => {
                            set({ q });
                        },
                    }}
                    fields={runFields(view, set)}
                    onClear={() => {
                        setView(NO_VIEW);
                    }}
                />
            )}
        />
    );
}

function FilterBarDemo({ initial }: { readonly initial: RunView }) {
    const [view, setView] = useState(initial);
    const set = (patch: Partial<RunView>) => {
        setView((current) => ({ ...current, ...patch }));
    };
    return (
        <FilterBar
            label="Filter runs"
            search={{
                label: 'Search runs',
                value: view.q,
                onChange: (q) => {
                    set({ q });
                },
            }}
            fields={runFields(view, set)}
            sort={{
                options: [{ id: 'queuedAt', label: 'Queued' }],
                value: { id: 'queuedAt', desc: true },
                onChange: () => undefined,
            }}
            columns={{
                items: [
                    { id: 'status', label: 'Status', visible: true, disabled: false },
                    { id: 'cost', label: 'Cost', visible: false, disabled: false },
                ],
                onToggle: () => undefined,
            }}
        />
    );
}

/** Narrow viewports (the CSP suite's 360 px pass) show the bar scrolling sideways behind a fade. */
export const filterBarGallery: GalleryEntry = {
    id: 'filter-bar',
    title: 'FilterBar',
    render: () => (
        <div className="flex flex-col gap-8">
            <FilterBarDemo
                initial={{
                    ...NO_VIEW,
                    status: ['running', 'waiting'],
                    agent: ['max'],
                    queued: { from: '2026-11-09', to: '2026-11-13' },
                }}
            />
            <FilterBarDemo
                initial={{ ...NO_VIEW, status: ['running', 'waiting', 'queued', 'failed'], source: 'email' }}
            />
            <FilterBarDemo initial={NO_VIEW} />
            <RunsListDemo initial={{ ...NO_VIEW, agent: ['max', 'copywriter'] }} grouped={false} />
        </div>
    ),
};
