import {
    Banner,
    Button,
    Card,
    CopyButton,
    createDataTableColumnHelper,
    DataTable,
    EmptyState,
    TrustMark,
} from '@ptbk/ui';
import { deriveEngineFingerprint } from '@ptbk/protocol';
import type { DataTableColumnDef } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, Server } from 'lucide-react';
import { useMemo, useState } from 'react';

import { m } from '../../../paraglide/messages';
import type { EngineView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { enginesQuery } from '../../api/queries';
import { engineLabel } from '../../../shared/engine-label';
import { ButtonLink, Link } from '../../core/link';
import { useSession } from '../session/use-session';
import { EngineOpenLink } from './engine-open-link';
import { EngineReachability } from './engine-reachability';
import { EngineStatusBadge } from './engine-status-badge';
import { updateStateLabel } from './engine-labels';
import { byAttention, isRevoked, reportsLive } from './engine-order';
import { LastSeen, useNowFor } from './engine-values';

const READ_PERMISSION = 'engine.read';
const LINK_PERMISSION = 'engine.link';
/** One screen of rows; past it only the visible window is mounted. */
const ENGINE_PAGE_ROWS = 50;
const NO_ENGINES: readonly EngineView[] = [];

const columns = createDataTableColumnHelper<EngineView>();

/** One line, never broken mid-label: a cut-off address keeps its full value in the tooltip and the copy button. */
function Address(props: { readonly engine: EngineView }) {
    const { engine } = props;
    return (
        <span className="flex flex-col gap-1">
            <span className="flex items-center gap-1 whitespace-nowrap">
                <code
                    title={engine.hostname}
                    className="min-w-0 truncate rounded-small bg-(--code-text-bg) px-1.5 py-0.5 font-mono text-sm text-(--code-text-text)"
                >
                    {engine.hostname}
                </code>
                <CopyButton value={engine.hostname} label={m.engines_copy_hostname()} />
                {engine.status === 'suspended' ? null : (
                    <EngineOpenLink name={engineLabel(engine)} hostname={engine.hostname} />
                )}
            </span>
            {engine.customHostnames.map((hostname) => (
                <span key={hostname} title={hostname} className="truncate font-mono text-xs text-text-muted">
                    {hostname}
                </span>
            ))}
        </span>
    );
}

/**
 * What an owner scans for: which engine, whether it is up and when it last reported, where it is, and whether it needs
 * an update. The heartbeat's numbers (agents, members, disk, memory, CPU) are on each engine's page.
 */
function engineColumns(now: Date): DataTableColumnDef<EngineView>[] {
    return [
        columns.accessor('engineId', {
            header: m.engines_column_engine(),
            cell: ({ row }) => (
                <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    <TrustMark
                        fingerprint={deriveEngineFingerprint(row.original.engineId)}
                        state="verified"
                        size="sm"
                        showCode={false}
                        label={m.engines_fingerprint_label({ name: engineLabel(row.original) })}
                    />
                    <Link
                        to="/engines/$engineId"
                        params={{ engineId: row.original.engineId }}
                        className={row.original.label === null ? 'font-mono' : undefined}
                    >
                        {engineLabel(row.original)}
                    </Link>
                </span>
            ),
            meta: { priority: 0 },
        }),
        columns.accessor('status', {
            header: m.engines_column_status(),
            cell: ({ row }) => (
                <span className="flex flex-col items-start gap-1 whitespace-nowrap">
                    <EngineStatusBadge engine={row.original} />
                    <span className="text-xs text-text-muted">
                        <LastSeen engine={row.original} now={now} />
                    </span>
                    <EngineReachability engine={row.original} />
                </span>
            ),
            meta: { priority: 1 },
        }),
        columns.accessor('hostname', {
            header: m.engines_column_hostname(),
            cell: ({ row }) => <Address engine={row.original} />,
            meta: { priority: 2 },
        }),
        columns.display({
            id: 'version',
            header: m.engines_column_version(),
            cell: ({ row }) => {
                // What a silent engine last reported is history: muted, and no update it may long have installed.
                const live = reportsLive(row.original);
                const update = live ? row.original.heartbeat?.update : undefined;
                return (
                    <span className="flex flex-col gap-1 whitespace-nowrap">
                        <span className={`font-mono text-sm ${live ? '' : 'text-text-muted'}`}>
                            {row.original.heartbeat?.version ?? row.original.registeredVersion}
                        </span>
                        {update === undefined || update === 'none' ? null : (
                            <span className="text-xs text-text-muted">{updateStateLabel(update)}</span>
                        )}
                    </span>
                );
            },
            meta: { label: m.engines_column_version(), priority: 3 },
        }),
    ];
}

/**
 * Without engines there is nothing to compare across columns, so the page leads with the one next step instead
 * of an empty table.
 */
function NoEngines(props: { readonly canLink: boolean }) {
    return (
        <Card>
            <EmptyState
                icon={<Server aria-hidden className="size-6" />}
                title={m.engines_empty_title()}
                headingLevel={2}
                description={m.engines_empty_body()}
                {...(props.canLink
                    ? {
                          action: (
                              <ButtonLink to="/engines/new" variant="primary">
                                  <Plus aria-hidden className="size-4" />
                                  {m.engines_add()}
                              </ButtonLink>
                          ),
                      }
                    : {})}
            />
        </Card>
    );
}

/** `/engines`, the signed-in landing page: registry data and heartbeat numbers, never anything from the engines. */
export function EngineListPage() {
    const api = useApiClient();
    const session = useSession();
    const canRead = session.activeOrg.permissions.includes(READ_PERMISSION);
    const canLink = session.activeOrg.permissions.includes(LINK_PERMISSION);
    const engines = useQuery({ ...enginesQuery(api), enabled: canRead });
    const now = useNowFor(engines.dataUpdatedAt);
    const tableColumns = useMemo(() => engineColumns(now), [now]);
    const hasEngines = (engines.data?.length ?? 0) > 0;
    const [showRevoked, setShowRevoked] = useState(false);
    const ordered = useMemo(() => byAttention(engines.data ?? NO_ENGINES), [engines.data]);
    const revoked = ordered.filter(isRevoked).length;
    // Revoked engines can never come back; they stay one click away, unless nothing else is left to show.
    const hideRevoked = !showRevoked && revoked < ordered.length;
    const rows = useMemo(
        () => (hideRevoked ? ordered.filter((engine) => !isRevoked(engine)) : ordered),
        [hideRevoked, ordered],
    );

    function content() {
        if (!canRead) {
            return <Banner tone="info">{m.engines_not_allowed()}</Banner>;
        }
        if (engines.data !== undefined && !hasEngines) {
            return <NoEngines canLink={canLink} />;
        }
        return (
            <div className="flex flex-col gap-3">
                <DataTable<EngineView>
                    caption={m.engines_table_caption()}
                    mode="client"
                    columns={tableColumns}
                    data={rows}
                    getRowId={(engine) => engine.engineId}
                    getRowLabel={engineLabel}
                    loading={engines.isPending}
                    virtualizeAbove={ENGINE_PAGE_ROWS}
                    skeletonRows={2}
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
                {revoked === 0 || revoked === ordered.length ? null : (
                    <div>
                        <Button
                            variant="ghost"
                            size="sm"
                            aria-pressed={showRevoked}
                            onClick={() => {
                                setShowRevoked(!showRevoked);
                            }}
                        >
                            {m.engines_show_revoked({ count: revoked })}
                        </Button>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="font-display text-2xl font-semibold">{m.engines_title()}</h1>
                {canLink && hasEngines ? (
                    <Link to="/engines/new" variant="standalone" className="inline-flex items-center gap-1">
                        <Plus aria-hidden className="size-4" />
                        {m.engines_add()}
                    </Link>
                ) : null}
            </div>
            {content()}
        </div>
    );
}
