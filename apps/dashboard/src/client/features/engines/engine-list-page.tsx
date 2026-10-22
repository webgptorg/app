import { Banner, CodeText, CopyButton, createDataTableColumnHelper, DataTable, TrustMark, useLocale } from '@ptbk/ui';
import type { DataTableColumnDef, Formatters } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo } from 'react';

import { m } from '../../../paraglide/messages';
import type { EngineView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { enginesQuery } from '../../api/queries';
import { Link } from '../../core/link';
import { useSession } from '../session/use-session';
import { EngineOpenLink } from './engine-open-link';
import { EngineStatusBadge } from './engine-status-badge';
import { cpuLoadLabel, shortEngineId, updateStateLabel } from './engine-labels';
import { LastSeen, NotReported, useNowFor } from './engine-values';

const READ_PERMISSION = 'engine.read';
const LINK_PERMISSION = 'engine.link';
/** One screen of rows; past it only the visible window is mounted. */
const ENGINE_PAGE_ROWS = 50;
const NO_ENGINES: readonly EngineView[] = [];

const columns = createDataTableColumnHelper<EngineView>();

function percent(formatters: Formatters, value: number | undefined) {
    return value === undefined ? <NotReported /> : formatters.formatNumber(value / 100, { style: 'percent' });
}

function count(formatters: Formatters, value: number | undefined) {
    return value === undefined ? <NotReported /> : formatters.formatNumber(value);
}

function engineColumns(formatters: Formatters, now: Date): DataTableColumnDef<EngineView>[] {
    return [
        columns.accessor('engineId', {
            header: m.engines_column_engine(),
            cell: ({ row }) => (
                <span className="inline-flex items-center gap-1">
                    <Link to="/engines/$engineId" params={{ engineId: row.original.engineId }} className="font-mono">
                        {`${shortEngineId(row.original.engineId)}…`}
                    </Link>
                    <CopyButton
                        value={row.original.engineId}
                        label={m.engines_copy_id({ engineId: shortEngineId(row.original.engineId) })}
                    />
                </span>
            ),
            meta: { priority: 0 },
        }),
        columns.accessor('status', {
            header: m.engines_column_status(),
            cell: ({ row }) => <EngineStatusBadge engine={row.original} />,
            meta: { priority: 1 },
        }),
        columns.display({
            id: 'fingerprint',
            header: m.engines_column_fingerprint(),
            cell: ({ row }) => (
                <TrustMark
                    engineId={row.original.engineId}
                    state="verified"
                    size="sm"
                    label={m.engines_fingerprint_label({ shortId: shortEngineId(row.original.engineId) })}
                />
            ),
            meta: { label: m.engines_column_fingerprint(), priority: 2 },
        }),
        columns.accessor('hostname', {
            header: m.engines_column_hostname(),
            cell: ({ row }) => (
                <span className="flex flex-col items-start gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                        <CodeText value={row.original.hostname} copyable copyLabel={m.engines_copy_hostname()} />
                        {row.original.status === 'suspended' ? null : (
                            <EngineOpenLink engineId={row.original.engineId} hostname={row.original.hostname} />
                        )}
                    </span>
                    {row.original.customHostnames.map((hostname) => (
                        <span key={hostname} className="font-mono text-xs text-text-muted">
                            {hostname}
                        </span>
                    ))}
                </span>
            ),
            meta: { priority: 3 },
        }),
        columns.accessor('lastSeenAt', {
            header: m.engines_column_last_seen(),
            cell: ({ row }) => <LastSeen engine={row.original} now={now} />,
            meta: { priority: 4 },
        }),
        columns.display({
            id: 'version',
            header: m.engines_column_version(),
            cell: ({ row }) => (
                <span className="font-mono text-sm">
                    {row.original.heartbeat?.version ?? row.original.registeredVersion}
                </span>
            ),
            meta: { label: m.engines_column_version(), priority: 5 },
        }),
        columns.display({
            id: 'update',
            header: m.engines_column_update(),
            cell: ({ row }) => {
                const update = row.original.heartbeat?.update;
                return update === undefined ? <NotReported /> : updateStateLabel(update);
            },
            meta: { label: m.engines_column_update(), priority: 6 },
        }),
        columns.display({
            id: 'agents',
            header: m.engines_column_agents(),
            cell: ({ row }) => count(formatters, row.original.heartbeat?.agents),
            meta: { label: m.engines_column_agents(), priority: 7 },
        }),
        columns.display({
            id: 'members',
            header: m.engines_column_members(),
            cell: ({ row }) => count(formatters, row.original.heartbeat?.members),
            meta: { label: m.engines_column_members(), priority: 8 },
        }),
        columns.display({
            id: 'disk',
            header: m.engines_column_disk(),
            cell: ({ row }) => percent(formatters, row.original.heartbeat?.diskPct),
            meta: { label: m.engines_column_disk(), priority: 9 },
        }),
        columns.display({
            id: 'ram',
            header: m.engines_column_ram(),
            cell: ({ row }) => percent(formatters, row.original.heartbeat?.ramPct),
            meta: { label: m.engines_column_ram(), priority: 10 },
        }),
        columns.display({
            id: 'cpu',
            header: m.engines_column_cpu(),
            cell: ({ row }) => {
                const load = row.original.heartbeat?.cpuLoad;
                return load === undefined ? <NotReported /> : cpuLoadLabel(load);
            },
            meta: { label: m.engines_column_cpu(), priority: 11 },
        }),
    ];
}

/** `/engines`, the signed-in landing page: registry data and heartbeat numbers, never anything from the engines. */
export function EngineListPage() {
    const api = useApiClient();
    const formatters = useLocale();
    const session = useSession();
    const canRead = session.activeOrg.permissions.includes(READ_PERMISSION);
    const canLink = session.activeOrg.permissions.includes(LINK_PERMISSION);
    const engines = useQuery({ ...enginesQuery(api), enabled: canRead });
    const now = useNowFor(engines.dataUpdatedAt);
    const tableColumns = useMemo(() => engineColumns(formatters, now), [formatters, now]);
    const addLink = (
        <Link to="/engines/new" variant="standalone" className="inline-flex items-center gap-1">
            <Plus aria-hidden className="size-4" />
            {m.engines_add()}
        </Link>
    );

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="font-display text-2xl font-semibold">{m.engines_title()}</h1>
                {canLink && (engines.data?.length ?? 0) > 0 ? addLink : null}
            </div>
            {canRead ? (
                <DataTable<EngineView>
                    caption={m.engines_table_caption()}
                    mode="client"
                    columns={tableColumns}
                    data={engines.data ?? NO_ENGINES}
                    getRowId={(engine) => engine.engineId}
                    getRowLabel={(engine) => shortEngineId(engine.engineId)}
                    loading={engines.isPending}
                    virtualizeAbove={ENGINE_PAGE_ROWS}
                    skeletonRows={2}
                    empty={{
                        title: m.engines_empty_title(),
                        description: m.engines_empty_body(),
                        ...(canLink ? { action: addLink } : {}),
                    }}
                    {...(engines.isError
                        ? {
                              error: {
                                  message: m.engines_error(),
                                  onRetry: () => void engines.refetch(),
                                  retrying: engines.isFetching,
                              },
                          }
                        : {})}
                />
            ) : (
                <Banner tone="info">{m.engines_not_allowed()}</Banner>
            )}
        </div>
    );
}
