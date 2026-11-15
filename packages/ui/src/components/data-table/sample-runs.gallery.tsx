import { Bot, CalendarClock, CircleDot, Coins, Hash, Timer, Zap } from 'lucide-react';

import { Avatar } from '../avatar/avatar';
import { EntityChip } from '../entity-chip/entity-chip';
import { RelativeTime } from '../relative-time/relative-time';
import { StatusPill } from '../status/status';
import type { StatusTone } from '../status/status';
import { createDataTableColumnHelper } from './columns';
import type { DataTableColumnDef } from './columns';

/** Realistic runs for the table and filter bar galleries; fixed times, so screenshots do not drift. */
export const SAMPLE_NOW = new Date('2026-11-13T15:00:00Z');

export type SampleRunStatus = 'running' | 'waiting' | 'queued' | 'completed' | 'failed' | 'stopped';
export type SampleSource = 'chat' | 'schedule' | 'email' | 'api';

export interface SampleAgent {
    readonly id: string;
    readonly name: string;
    readonly tint: string;
}

export interface SampleRun {
    readonly id: string;
    readonly title: string;
    readonly now: string | null;
    readonly status: SampleRunStatus;
    readonly agent: SampleAgent;
    readonly source: SampleSource;
    readonly queuedAt: Date;
    readonly durationMs: number | null;
    readonly cost: string | null;
}

export const SAMPLE_AGENTS: readonly SampleAgent[] = [
    { id: 'ada', name: 'Ada', tint: 'var(--color-agent-1)' },
    { id: 'max', name: 'Max', tint: 'var(--color-agent-3)' },
    { id: 'iris', name: 'Iris', tint: 'var(--color-agent-5)' },
    { id: 'copywriter', name: 'Copywriter', tint: 'var(--color-agent-7)' },
];

export const STATUS_TONES: Readonly<Record<SampleRunStatus, StatusTone>> = {
    running: 'live',
    waiting: 'warning',
    queued: 'waiting',
    completed: 'success',
    failed: 'danger',
    stopped: 'neutral',
};

export const STATUS_LABELS: Readonly<Record<SampleRunStatus, string>> = {
    running: 'Running',
    waiting: 'Needs you',
    queued: 'Queued',
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
};

export const SOURCE_LABELS: Readonly<Record<SampleSource, string>> = {
    chat: 'Chat',
    schedule: 'Schedule',
    email: 'Email',
    api: 'API',
};

const minutesAgo = (minutes: number) => new Date(SAMPLE_NOW.getTime() - minutes * 60_000);
const agent = (index: number): SampleAgent =>
    SAMPLE_AGENTS[index % SAMPLE_AGENTS.length] ?? { id: 'ada', name: 'Ada', tint: 'var(--color-agent-1)' };

let sequence = 0;
function run(
    title: string,
    now: string | null,
    status: SampleRunStatus,
    agentIndex: number,
    source: SampleSource,
    ago: number,
    durationMs: number | null,
    cost: string | null,
): SampleRun {
    sequence += 1;
    return {
        id: `run-${String(sequence)}`,
        title,
        now,
        status,
        agent: agent(agentIndex),
        source,
        queuedAt: minutesAgo(ago),
        durationMs,
        cost,
    };
}

export const SAMPLE_RUNS: readonly SampleRun[] = [
    run('Answer a refund request', 'Looking up the order', 'running', 1, 'email', 3, 121_000, null),
    run(
        'Draft the launch post for the new pricing page',
        'Writing the second section',
        'running',
        3,
        'chat',
        6,
        64_000,
        null,
    ),
    run('Confirm which calendar to read', null, 'waiting', 2, 'chat', 14, 30_000, null),
    run('Summarise the open pull requests', null, 'queued', 0, 'api', 1, null, null),
    run(
        'Write the weekly report from the calendar and the reports project',
        null,
        'completed',
        2,
        'schedule',
        23 * 60,
        360_000,
        '0.31',
    ),
    run('Please review the billing pull request', null, 'completed', 0, 'chat', 62, 600_000, '0.42'),
    run('Reply to the supplier about the late delivery', null, 'failed', 1, 'email', 26 * 60, 240_000, null),
    run('A run from a chat', null, 'stopped', 1, 'chat', 5 * 60, 240_000, null),
    run('Tidy the onboarding checklist', null, 'completed', 3, 'chat', 3 * 24 * 60, 95_000, '0.08'),
];

function formatDuration(ms: number | null): string {
    if (ms === null) return '—';
    const seconds = Math.floor(ms / 1000);
    return seconds < 60 ? `${String(seconds)} s` : `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
}

export function AgentCell({ agent: value }: { readonly agent: SampleAgent }) {
    return (
        <EntityChip
            label={value.name}
            tint={value.tint}
            leading={<Avatar name={value.name} tint={value.tint} size="2xs" />}
        />
    );
}

const helper = createDataTableColumnHelper<SampleRun>();
export const SAMPLE_RUN_COLUMNS: DataTableColumnDef<SampleRun>[] = helper.columns([
    helper.accessor('title', {
        header: 'Run',
        enableHiding: false,
        enableSorting: false,
        meta: { icon: <Hash className="size-3.5" />, priority: 0 },
        cell: ({ row }) => (
            <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{row.original.title}</span>
                {row.original.now === null ? null : (
                    <span className="truncate text-xs text-text-muted">{row.original.now}</span>
                )}
            </span>
        ),
    }),
    helper.accessor('status', {
        header: 'Status',
        enableSorting: false,
        meta: { icon: <CircleDot className="size-3.5" />, priority: 1 },
        cell: ({ row }) => (
            <StatusPill tone={STATUS_TONES[row.original.status]}>{STATUS_LABELS[row.original.status]}</StatusPill>
        ),
    }),
    helper.accessor((run) => run.agent.name, {
        id: 'agent',
        header: 'Agent',
        enableSorting: false,
        meta: { icon: <Bot className="size-3.5" />, priority: 2 },
        cell: ({ row }) => <AgentCell agent={row.original.agent} />,
    }),
    helper.accessor('source', {
        header: 'Source',
        enableSorting: false,
        meta: { icon: <Zap className="size-3.5" />, priority: 4 },
        cell: ({ row }) => SOURCE_LABELS[row.original.source],
    }),
    helper.accessor('queuedAt', {
        header: 'Queued',
        sortFn: 'datetime',
        meta: { icon: <CalendarClock className="size-3.5" />, priority: 3, trailing: true, numeric: true },
        cell: ({ row }) => (
            <RelativeTime value={row.original.queuedAt} now={SAMPLE_NOW} className="whitespace-nowrap" />
        ),
    }),
    helper.accessor('durationMs', {
        header: 'Duration',
        sortFn: 'basic',
        meta: { icon: <Timer className="size-3.5" />, priority: 5, numeric: true },
        cell: ({ row }) => formatDuration(row.original.durationMs),
    }),
    helper.accessor('cost', {
        header: 'Cost',
        enableSorting: false,
        meta: { icon: <Coins className="size-3.5" />, priority: 6, numeric: true, defaultHidden: true },
        cell: ({ row }) => (row.original.cost === null ? '—' : `$${row.original.cost}`),
    }),
]);

export const SAMPLE_GROUPS = [
    { id: 'now', label: 'Now' },
    { id: 'next', label: 'Coming up' },
    { id: 'done', label: 'Done' },
] as const;

export function sampleGroupOf(run: SampleRun): string {
    if (run.status === 'running' || run.status === 'waiting') return 'now';
    if (run.status === 'queued') return 'next';
    return 'done';
}
