import type { Money, ReadRun } from '@ptbk/engine-api';
import { useLocale } from '@ptbk/ui';

import { useNow } from '../../app/ticker';
import { m } from '../../paraglide/messages';
import { sourceLabel } from '../chat/chat-source';

/** What a row or the detail header calls the run: the agent's own progress title, else what started it. */
export function runTitle(run: Pick<ReadRun, 'progress' | 'preview' | 'source'>): string {
    const title = run.progress?.title.trim();
    if (title !== undefined && title !== '') return title;
    const preview = run.preview?.trim();
    if (preview !== undefined && preview !== '') return preview;
    return m.run_untitled({ source: sourceLabel(run.source) });
}

/** "45 s", "3 min 05 s", "2 h 07 min"; whole seconds. */
export function formatDuration(ms: number, formatNumber: (value: number) => string): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return m.duration_hours_minutes({ hours: formatNumber(hours), minutes: formatNumber(minutes) });
    if (minutes > 0) {
        return m.duration_minutes_seconds({ minutes: formatNumber(minutes), seconds: formatNumber(seconds) });
    }
    return m.duration_seconds({ seconds: formatNumber(seconds) });
}

function finishedDurationMs(run: Pick<ReadRun, 'startedAt' | 'completedAt' | 'usage'>): number | null {
    if (run.usage?.durationMs !== null && run.usage?.durationMs !== undefined) return run.usage.durationMs;
    if (run.startedAt === null || run.completedAt === null) return null;
    return Date.parse(run.completedAt) - Date.parse(run.startedAt);
}

type DurationRun = Pick<ReadRun, 'status' | 'startedAt' | 'completedAt' | 'usage'>;

/** A running run counts up from the shared clock, never by refetching; a finished one shows what the engine reported. */
export function RunDuration({ run }: { readonly run: DurationRun }) {
    if (run.status === 'running' && run.startedAt !== null) return <LiveDuration startedAt={run.startedAt} />;
    return <StaticDuration ms={finishedDurationMs(run)} />;
}

function LiveDuration({ startedAt }: { readonly startedAt: string }) {
    const now = useNow();
    const locale = useLocale();
    const ms = now - Date.parse(startedAt);
    return <span className="tabular-nums">{formatDuration(ms, (value) => locale.formatNumber(value))}</span>;
}

/** What the engine reported (`usage.durationMs`), or the live elapsed time while the run is going. */
export function ReportedDuration({ run }: { readonly run: DurationRun }) {
    if (run.status === 'running' && run.startedAt !== null) return <LiveDuration startedAt={run.startedAt} />;
    return <StaticDuration ms={run.usage?.durationMs ?? null} />;
}

function StaticDuration({ ms }: { readonly ms: number | null }) {
    const locale = useLocale();
    if (ms === null) return <span className="text-text-muted">{m.run_value_unknown()}</span>;
    return <span className="tabular-nums">{formatDuration(ms, (value) => locale.formatNumber(value))}</span>;
}

/** The engine's decimal string, formatted exactly; never summed or rounded through a float. */
export function RunCost({ cost }: { readonly cost: Money | null | undefined }) {
    const locale = useLocale();
    if (cost === null || cost === undefined) return <span className="text-text-muted">{m.run_value_unknown()}</span>;
    return <span className="tabular-nums">{locale.formatCurrency(cost.amount, cost.currency)}</span>;
}
