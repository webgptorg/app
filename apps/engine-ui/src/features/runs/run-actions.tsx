import type { ReadRun } from '@ptbk/engine-api';
import { Button } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { CircleStop, RotateCcw } from 'lucide-react';

import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { runTitle } from './run-format';
import { canCancel, canRetry, useRunMutations } from './use-run-mutations';

type ActionRun = Pick<ReadRun, 'id' | 'status' | 'cancelRequestedAt' | 'progress' | 'preview' | 'source'>;

/** The row menu's entries for one run; empty without `runs.control`, so the menu is not rendered at all. */
export function useRunRowActions(): (run: ActionRun) => readonly MenuEntry[] {
    const { can } = usePermissions();
    const { cancel, retry } = useRunMutations();
    return (run) => {
        if (!can('runs.control')) return [];
        const target = { id: run.id, title: runTitle(run) };
        const entries: MenuEntry[] = [];
        if (canCancel(run)) {
            entries.push({
                kind: 'item',
                id: 'cancel',
                label: m.run_cancel(),
                icon: <CircleStop aria-hidden />,
                tone: 'danger',
                onSelect: () => {
                    cancel.mutate(target);
                },
            });
        }
        if (canRetry(run)) {
            entries.push({
                kind: 'item',
                id: 'retry',
                label: m.run_retry(),
                icon: <RotateCcw aria-hidden />,
                onSelect: () => {
                    retry.mutate(target);
                },
            });
        }
        return entries;
    };
}

/** Cancel (one step, no dialog) and retry for the detail page; nothing without `runs.control`. */
export function RunActions({ run }: { readonly run: ActionRun }) {
    const { can } = usePermissions();
    const { cancel, retry } = useRunMutations();
    if (!can('runs.control')) return null;
    const target = { id: run.id, title: runTitle(run) };
    const showCancel = canCancel(run);
    const showRetry = canRetry(run);
    if (!showCancel && !showRetry) return null;
    return (
        <div className="flex flex-wrap gap-2">
            {showCancel ? (
                <Button
                    variant="danger"
                    loading={cancel.isPending}
                    onClick={() => {
                        cancel.mutate(target);
                    }}
                >
                    <CircleStop aria-hidden className="size-4" />
                    {m.run_cancel()}
                </Button>
            ) : null}
            {showRetry ? (
                <Button
                    variant="primary"
                    loading={retry.isPending}
                    onClick={() => {
                        retry.mutate(target);
                    }}
                >
                    <RotateCcw aria-hidden className="size-4" />
                    {m.run_retry()}
                </Button>
            ) : null}
        </div>
    );
}
