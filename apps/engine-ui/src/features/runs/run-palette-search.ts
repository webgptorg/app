import { RunId } from '@ptbk/engine-api';
import type { ReadRun } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Activity, CircleStop } from 'lucide-react';

import { useDebouncedValue } from '../../app/debounced-value';
import { useEngineApi } from '../../app/engine-api-context';
import type { PaletteResult, PaletteSearch } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { matchesQuery } from '../shell/palette/palette-match';
import { usePermissions } from '../session/use-permissions';
import { runTitle } from './run-format';
import { runListQueryOptions, runQueryOptions } from './runs-queries';
import { canCancel, useRunMutations } from './use-run-mutations';

const RECENT_RUNS = 5;
const SEARCH_DEBOUNCE_MS = 200;
/** IDs are opaque; shorter text is a word being typed, not worth a lookup. */
const MIN_ID_LENGTH = 4;
/** Never fetched: stands in while the text is not a run ID. */
const NO_RUN = RunId.parse('none');

/**
 * The palette's runs: the most recent ones, matched by ID, title or agent, plus the run whose ID was typed. Each opens
 * its detail; one still going can be stopped from here with `runs.control`, the same one step as on its page.
 */
export function useRunPaletteResults(query: string): PaletteSearch {
    const engineApi = useEngineApi();
    const router = useRouter();
    const { can } = usePermissions();
    const { cancel } = useRunMutations();
    const text = query.trim();
    const settled = useDebouncedValue(text, SEARCH_DEBOUNCE_MS);
    const parsed = RunId.safeParse(settled);
    const typedId = parsed.success && settled.length >= MIN_ID_LENGTH ? parsed.data : null;
    const recent = useQuery(runListQueryOptions(engineApi, { limit: RECENT_RUNS }));
    const exact = useQuery({ ...runQueryOptions(engineApi, typedId ?? NO_RUN), enabled: typedId !== null });

    const runs: ReadRun[] = (recent.data?.items ?? []).filter((run) =>
        matchesQuery(text, [run.id, runTitle(run), run.agentName ?? '']),
    );
    if (typedId !== null && exact.data !== undefined && !runs.some((run) => run.id === exact.data.id)) {
        runs.unshift(exact.data);
    }

    const results = runs.flatMap((run): PaletteResult[] => {
        const title = runTitle(run);
        const target = { to: '/runs/$runId', params: { runId: run.id } } as const;
        const detail = run.agentName === null ? run.id : `${run.agentName} · ${run.id}`;
        const open: PaletteResult = {
            id: `${run.id}:open`,
            label: m.palette_run_open({ title }),
            detail,
            icon: Activity,
            select: () => {
                void router.navigate(target);
            },
            preload: () => {
                void router.preloadRoute(target).catch(() => undefined);
            },
        };
        if (!can('runs.control') || !canCancel(run)) return [open];
        return [
            open,
            {
                id: `${run.id}:stop`,
                label: m.palette_run_stop({ title }),
                detail,
                icon: CircleStop,
                select: () => {
                    cancel.mutate({ id: run.id, title });
                },
            },
        ];
    });
    const loading = text !== settled || recent.isFetching || (typedId !== null && exact.isFetching);
    return { results, loading };
}
