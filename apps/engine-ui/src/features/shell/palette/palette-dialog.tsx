import { CommandPalette } from '@ptbk/ui';
import type { CommandPaletteGroup, CommandPaletteItem } from '@ptbk/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { Bot, CornerDownRight } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useDebouncedValue } from '../../../app/debounced-value';
import { useEngineApi } from '../../../app/engine-api-context';
import type {
    FeatureDefinition,
    NavIcon,
    PaletteSearch,
    PaletteSearchEntry,
    RoutePath,
} from '../../../app/registry/feature';
import { useAllows, useVisibleFeatures } from '../../../app/registry/use-visible-features';
import { m } from '../../../paraglide/messages';
import { agentListQueryOptions } from '../../agents/agents-queries';
import { matchesQuery } from './palette-match';

/** Typing settles this long before the palette asks the engine. */
export const PALETTE_SEARCH_DEBOUNCE_MS = 200;
const AGENT_RESULTS = 8;

interface PaletteItem extends CommandPaletteItem {
    readonly select: () => void;
    readonly preload?: () => void;
}

function iconOf(Icon: NavIcon | undefined) {
    return Icon === undefined ? undefined : <Icon aria-hidden className="size-4" />;
}

export interface PaletteDialogProps {
    readonly open: boolean;
    readonly onClose: () => void;
}

/**
 * The command palette's content, loaded on first open: the sidebar's places, agents from the engine, what features
 * find themselves (runs by ID) and every registered command, all filtered by what the member may use.
 */
export function PaletteDialog({ open, onClose }: PaletteDialogProps) {
    const [query, setQuery] = useState('');
    const features = useVisibleFeatures();
    const navigate = useNavigate();
    const agents = useAgentResults(query);
    const [provided, setProvided] = useState<ReadonlyMap<string, PaletteSearch>>(new Map());
    const [onResults] = useState(() => (id: string, search: PaletteSearch) => {
        setProvided((previous) => {
            const before = previous.get(id);
            return before !== undefined && signature(before) === signature(search)
                ? previous
                : new Map(previous).set(id, search);
        });
    });
    const searches = features.flatMap((feature) =>
        feature.paletteSearch === undefined ? [] : [feature.paletteSearch],
    );
    const close = () => {
        setQuery('');
        onClose();
    };

    const go = (to: RoutePath) => () => {
        void navigate({ to });
    };
    const groups: CommandPaletteGroup<PaletteItem>[] = [
        {
            id: 'navigation',
            label: m.palette_group_navigation(),
            items: navigationItems(features, query).map(({ id, label, icon, to }) => ({
                id: `nav:${id}`,
                label,
                ...(icon === undefined ? {} : { icon: iconOf(icon) }),
                select: go(to),
            })),
        },
        { id: 'agents', label: m.palette_group_agents(), items: agents.items },
        ...searches.map((search) => ({
            id: `search:${search.id}`,
            label: search.label(),
            items: (provided.get(search.id)?.results ?? []).map((result) => ({
                id: `search:${search.id}:${result.id}`,
                label: result.label,
                ...(result.detail === undefined ? {} : { detail: result.detail }),
                ...(result.icon === undefined ? {} : { icon: iconOf(result.icon) }),
                select: result.select,
                ...(result.preload === undefined ? {} : { preload: result.preload }),
            })),
        })),
        {
            id: 'commands',
            label: m.palette_group_commands(),
            items: commandItems(features, query).map((command) => ({
                id: `command:${command.id}`,
                label: command.label(),
                icon: <CornerDownRight aria-hidden className="size-4" />,
                select: command.to === undefined ? command.run : go(command.to),
            })),
        },
    ];

    return (
        <>
            {open
                ? searches.map((search) => (
                      <SearchProbe key={search.id} search={search} query={query} onResults={onResults} />
                  ))
                : null}
            <CommandPalette<PaletteItem>
                open={open}
                onClose={close}
                title={m.palette_title()}
                label={m.palette_label()}
                query={query}
                onQueryChange={setQuery}
                groups={groups}
                onSelect={(item) => {
                    close();
                    item.select();
                }}
                onActiveChange={(item) => {
                    item.preload?.();
                }}
                loading={agents.loading || searches.some((search) => provided.get(search.id)?.loading === true)}
                emptyText={m.palette_empty()}
                resultsText={(count) => m.palette_results({ count })}
            />
        </>
    );
}

/** What the member would see of a feature's results; hooks may return new objects for the same results every render. */
function signature(search: PaletteSearch): string {
    return JSON.stringify([search.loading, search.results.map(({ id, label, detail }) => [id, label, detail])]);
}

/** Calls one feature's search hook; one component per feature keeps the rules of hooks. */
function SearchProbe({
    search,
    query,
    onResults,
}: {
    readonly search: PaletteSearchEntry;
    readonly query: string;
    readonly onResults: (id: string, results: PaletteSearch) => void;
}) {
    const results = search.useResults(query);
    useEffect(() => {
        onResults(search.id, results);
    }, [search.id, results, onResults]);
    return null;
}

interface NavigationItem {
    readonly id: string;
    readonly label: string;
    readonly icon?: NavIcon;
    readonly to: RoutePath;
}

/** Every sidebar entry the member sees, matched by its label. */
export function navigationItems(features: readonly FeatureDefinition[], query: string): NavigationItem[] {
    return features.flatMap((feature) => {
        if (feature.nav === undefined) return [];
        const label = feature.nav.label();
        return matchesQuery(query, [label])
            ? [{ id: feature.id, label, icon: feature.nav.icon, to: feature.nav.to }]
            : [];
    });
}

/** Every command the member may run (the registry already dropped those whose `requires` fail), by label and keywords. */
export function commandItems(features: readonly FeatureDefinition[], query: string) {
    return features.flatMap((feature) =>
        (feature.commands ?? []).filter((command) => matchesQuery(query, [command.label(), ...command.keywords()])),
    );
}

/**
 * Agents matching the text, through the agents feature's query keys, so a result's preload warms the cache its
 * page reads. Typing waits 200 ms; a newer text drops the older request, which TanStack Query then aborts.
 */
function useAgentResults(query: string): { readonly items: PaletteItem[]; readonly loading: boolean } {
    const engineApi = useEngineApi();
    const router = useRouter();
    const allowed = useAllows({ permission: 'agents.read' });
    const text = query.trim();
    const settled = useDebouncedValue(text, PALETTE_SEARCH_DEBOUNCE_MS);
    const search = useQuery({
        ...agentListQueryOptions(
            engineApi,
            settled === '' ? { sort: '-updatedAt', limit: AGENT_RESULTS } : { q: settled, limit: AGENT_RESULTS },
        ),
        enabled: allowed,
        placeholderData: keepPreviousData,
    });
    if (!allowed) return { items: [], loading: false };
    // Until the engine answers for the current text, results for the previous text stay only where they still match,
    // so Enter never opens an agent the member already typed past.
    const items = (search.data?.items ?? [])
        .filter((agent) => matchesQuery(text, [agent.name, agent.profile.fullname, agent.profile.description]))
        .map((agent) => {
            const target = { to: '/agents/$agentId', params: { agentId: agent.id } } as const;
            return {
                id: `agent:${agent.id}`,
                label: agent.name,
                ...(agent.profile.description === '' ? {} : { detail: agent.profile.description }),
                icon: <Bot aria-hidden className="size-4" />,
                select: () => {
                    void router.navigate(target);
                },
                preload: () => {
                    void router.preloadRoute(target).catch(() => undefined);
                },
            };
        });
    return { items, loading: text !== settled || search.isFetching };
}
