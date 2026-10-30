import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';

import { useDebouncedValue } from '../../app/debounced-value';
import { useEngineApi } from '../../app/engine-api-context';
import type { PaletteResult, PaletteSearch } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { matchesQuery } from '../shell/palette/palette-match';
import { secretListQueryOptions } from './secrets-queries';

const SECRET_RESULTS = 5;
const SEARCH_DEBOUNCE_MS = 200;

/**
 * Secrets whose name matches the typed text, found by the engine. Secrets have no page of their own, so a result opens
 * the list searched for its name. Nothing is asked before the member types: a list of secret names is no shortcut.
 */
export function useSecretPaletteResults(query: string): PaletteSearch {
    const engineApi = useEngineApi();
    const router = useRouter();
    const text = query.trim();
    const settled = useDebouncedValue(text, SEARCH_DEBOUNCE_MS);
    const search = useQuery({
        ...secretListQueryOptions(
            engineApi,
            settled === '' ? { limit: SECRET_RESULTS } : { q: settled, limit: SECRET_RESULTS },
        ),
        enabled: settled !== '',
    });
    if (text === '') return { results: [], loading: false };
    const results = (search.data?.items ?? [])
        .filter((secret) => matchesQuery(text, [secret.name]))
        .map((secret): PaletteResult => {
            const target = { to: '/secrets', search: { q: secret.name } } as const;
            return {
                id: secret.id,
                label: secret.name,
                detail: secret.scope.kind === 'engine' ? m.secrets_scope_engine() : m.secrets_scope_agent(),
                icon: KeyRound,
                select: () => {
                    void router.navigate(target);
                },
                preload: () => {
                    void router.preloadRoute(target).catch(() => undefined);
                },
            };
        });
    return { results, loading: text !== settled || search.isFetching };
}
