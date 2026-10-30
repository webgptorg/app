import type { AgentId } from '@ptbk/engine-api';
import { CommandPalette } from '@ptbk/ui';
import type { CommandPaletteGroup, CommandPaletteItem } from '@ptbk/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { Bot, CornerDownRight } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useBrowser } from '../../../app/browser-context';
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
import { useCurrentMember } from '../../session/use-current-member';
import { navSections } from '../nav-groups';
import type { SidebarState } from '../sidebar-preference';
import { matchesQuery } from './palette-match';
import { readRecentPicks, rememberPick } from './palette-recent';
import type { RecentPick } from './palette-recent';
import { useShellCommands } from './shell-commands';

/** Typing settles this long before the palette asks the engine. */
export const PALETTE_SEARCH_DEBOUNCE_MS = 200;
const AGENT_RESULTS = 8;

interface PaletteItem extends CommandPaletteItem {
    readonly select: () => void;
    readonly preload?: (() => void) | undefined;
    /** How the item is kept among the recent picks; search results (runs, secrets) are not. */
    readonly recent?: RecentPick;
}

function iconOf(Icon: NavIcon | undefined) {
    return Icon === undefined ? undefined : <Icon aria-hidden className="size-4" />;
}

export interface PaletteDialogProps {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly sidebar: SidebarState | null;
}

/**
 * The command palette's content, loaded on first open: the sidebar's places, agents from the engine, what features
 * find themselves (runs by ID, secrets by name), every registered command and the shell's own (theme, language,
 * sidebar, sign-out), all filtered by what the member may use. Opened empty, it leads with the member's recent picks.
 */
export function PaletteDialog({ open, onClose, sidebar }: PaletteDialogProps) {
    const [query, setQuery] = useState('');
    const features = useVisibleFeatures();
    const navigate = useNavigate();
    const router = useRouter();
    const agents = useAgentResults(query);
    const shellCommands = useShellCommands(sidebar);
    const { storage } = useBrowser();
    const { memberId } = useCurrentMember();
    const [recent, setRecent] = useState(() => readRecentPicks(storage, memberId));
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

    const go = (to: RoutePath, search?: Readonly<Record<string, string>>) => () => {
        void navigate({ to, ...(search === undefined ? {} : { search }) });
    };
    const places: PaletteItem[] = navigationItems(features, query).map(({ id, label, icon, to }) => {
        const itemId = `nav:${id}`;
        return { id: itemId, label, icon: iconOf(icon), select: go(to), recent: { kind: 'item', id: itemId } };
    });
    const commands: PaletteItem[] = [
        ...commandItems(features, query).map((command): PaletteItem => {
            const itemId = `command:${command.id}`;
            return {
                id: itemId,
                label: command.label(),
                icon: <CornerDownRight aria-hidden className="size-4" />,
                select: command.to === undefined ? command.run : go(command.to, command.search),
                recent: { kind: 'item', id: itemId },
            };
        }),
        ...shellCommands
            .filter((command) => matchesQuery(query, [command.label, ...command.keywords]))
            .map(({ id, label, icon, run }): PaletteItem => ({ id, label, icon, select: run })),
    ];
    const featureResults = searches.map((search) => ({
        id: `search:${search.id}`,
        label: search.label(),
        items: (provided.get(search.id)?.results ?? []).map((result): PaletteItem => ({
            id: `search:${search.id}:${result.id}`,
            label: result.label,
            detail: result.detail,
            icon: iconOf(result.icon),
            select: result.select,
            preload: result.preload,
        })),
    }));

    // Typing narrows to what matches, places first; an empty palette leads with what the member is likely after.
    const browsing = query.trim() === '';
    const recentItems = browsing
        ? recent.flatMap((pick): PaletteItem[] => {
              if (pick.kind === 'agent') return [agentItem(router, pick.id, pick.label)];
              const item = [...places, ...commands].find((candidate) => candidate.id === pick.id);
              return item === undefined ? [] : [item];
          })
        : [];
    const shownAsRecent = new Set(recentItems.map((item) => item.id));
    const notRecent = (items: readonly PaletteItem[]) => items.filter((item) => !shownAsRecent.has(item.id));
    const recentGroup = { id: 'recent', label: m.palette_group_recent(), items: recentItems };
    const placesGroup = { id: 'navigation', label: m.palette_group_navigation(), items: notRecent(places) };
    const agentsGroup = { id: 'agents', label: m.palette_group_agents(), items: notRecent(agents.items) };
    const commandsGroup = { id: 'commands', label: m.palette_group_commands(), items: notRecent(commands) };
    const groups: CommandPaletteGroup<PaletteItem>[] = browsing
        ? [recentGroup, agentsGroup, placesGroup, ...featureResults, commandsGroup]
        : [placesGroup, agentsGroup, ...featureResults, commandsGroup];

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
                placeholder={m.palette_placeholder()}
                query={query}
                onQueryChange={setQuery}
                groups={groups}
                onSelect={(item) => {
                    if (item.recent !== undefined) setRecent(rememberPick(storage, memberId, item.recent));
                    close();
                    item.select();
                }}
                onActiveChange={(item) => {
                    item.preload?.();
                }}
                loading={agents.loading || searches.some((search) => provided.get(search.id)?.loading === true)}
                emptyText={m.palette_empty()}
                resultsText={(count) => m.palette_results({ count })}
                keyHints={[
                    { keys: '↑↓', label: m.palette_hint_move() },
                    { keys: '↵', label: m.palette_hint_open() },
                    { keys: 'Esc', label: m.palette_hint_close() },
                ]}
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
    readonly icon: NavIcon;
    readonly to: RoutePath;
}

/** Every sidebar entry the member sees, in the sidebar's order, matched by its label. */
export function navigationItems(features: readonly FeatureDefinition[], query: string): NavigationItem[] {
    return navSections(features).flatMap((section) =>
        section.items.flatMap((item) => {
            const label = item.label();
            return matchesQuery(query, [label]) ? [{ id: item.featureId, label, icon: item.icon, to: item.to }] : [];
        }),
    );
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
        .map((agent) => ({
            ...agentItem(router, agent.id, agent.name),
            ...(agent.profile.description === '' ? {} : { detail: agent.profile.description }),
        }));
    return { items, loading: text !== settled || search.isFetching };
}

function agentItem(router: ReturnType<typeof useRouter>, agentId: AgentId, name: string): PaletteItem {
    const target = { to: '/agents/$agentId', params: { agentId } } as const;
    return {
        id: `agent:${agentId}`,
        label: name,
        icon: <Bot aria-hidden className="size-4" />,
        select: () => {
            void router.navigate(target);
        },
        preload: () => {
            void router.preloadRoute(target).catch(() => undefined);
        },
        recent: { kind: 'agent', id: agentId, label: name },
    };
}
