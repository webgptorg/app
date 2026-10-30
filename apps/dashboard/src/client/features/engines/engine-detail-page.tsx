import { deriveEngineFingerprint } from '@ptbk/protocol';
import { Banner, Card, CodeText, EmptyState, ErrorState, ExternalLink, Skeleton, TrustMark, useLocale } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import type { EngineView, HeartbeatView } from '../../../shared/api/routes';
import { engineLabel, shortEngineId } from '../../../shared/engine-label';
import { useApiClient } from '../../api/api-client-context';
import { engineQuery, installGuideQuery, problemCode } from '../../api/queries';
import { ButtonLink, Link } from '../../core/link';
import { AbuseContactLink } from '../abuse/abuse-contact';
import { useSession } from '../session/use-session';
import { ENGINE_STATUS_COMMAND, TROUBLESHOOTING_ANCHOR } from './engine-guide';
import { cpuLoadLabel, modeLabel, updateStateLabel } from './engine-labels';
import { canRename, RenameEngineButton } from './engine-name';
import { EngineOpenLink } from './engine-open-link';
import { EngineReachability } from './engine-reachability';
import { EngineStatusBadge } from './engine-status-badge';
import { LastSeen, useNowFor } from './engine-values';
import { RevokeEngineCard } from './revoke-engine';

const READ_PERMISSION = 'engine.read';
const REVOKE_PERMISSION = 'engine.revoke';

function BackLink() {
    return (
        <Link to="/engines" variant="standalone" className="inline-flex items-center gap-1 self-start text-sm">
            <ArrowLeft aria-hidden className="size-4" />
            {m.engine_back()}
        </Link>
    );
}

/** A read-only list of facts, label beside value at every width; every value is plain text from our API. */
function Fields(props: { readonly fields: readonly (readonly [string, ReactNode])[] }) {
    return (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-6 gap-y-3 sm:grid-cols-[minmax(10rem,max-content)_1fr]">
            {props.fields.map(([label, value]) => (
                <div key={label} className="contents">
                    <dt className="text-sm text-text-muted">{label}</dt>
                    <dd className="min-w-0 text-sm">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

function HeartbeatFields(props: { readonly heartbeat: HeartbeatView }) {
    const formatters = useLocale();
    const { heartbeat } = props;
    const percent = (value: number) => formatters.formatNumber(value / 100, { style: 'percent' });
    return (
        <Fields
            fields={[
                [m.engine_heartbeat_version(), <span className="font-mono">{heartbeat.version}</span>],
                [m.engine_heartbeat_update(), updateStateLabel(heartbeat.update)],
                [m.engine_heartbeat_uptime(), formatters.formatDuration(heartbeat.uptimeS * 1000)],
                [m.engine_heartbeat_agents(), formatters.formatNumber(heartbeat.agents)],
                [m.engine_heartbeat_members(), formatters.formatNumber(heartbeat.members)],
                [m.engine_heartbeat_disk(), percent(heartbeat.diskPct)],
                [m.engine_heartbeat_ram(), percent(heartbeat.ramPct)],
                [m.engine_heartbeat_cpu(), cpuLoadLabel(heartbeat.cpuLoad)],
                [m.engine_heartbeat_sent(), formatters.formatDateTime(new Date(heartbeat.ts))],
                [m.engine_heartbeat_received(), formatters.formatDateTime(new Date(heartbeat.receivedAt))],
                // An opaque counter, not a quantity: shown as the engine sent it, without grouping.
                [m.engine_heartbeat_seq(), <span className="font-mono">{String(heartbeat.seq)}</span>],
            ]}
        />
    );
}

/**
 * The dashboard cannot reach into an engine, so for an offline one it can only say what the operator can check. The
 * guide link appears once its configured URL has loaded; the hint stands without it. When it was last seen is in the
 * page's summary, once.
 */
function OfflineHint() {
    const guide = useQuery(installGuideQuery(useApiClient()));
    return (
        <Banner tone="warning" title={m.engine_offline_title()}>
            <span className="flex flex-col items-start gap-2">
                <span>{m.engine_offline_hint()}</span>
                <CodeText value={ENGINE_STATUS_COMMAND} copyable copyLabel={m.engine_offline_copy()} />
                {guide.data === undefined ? null : (
                    <ExternalLink href={`${guide.data}#${TROUBLESHOOTING_ANCHOR}`}>
                        {m.engine_offline_troubleshooting()}
                    </ExternalLink>
                )}
            </span>
        </Banner>
    );
}

function StatusNotice(props: { readonly engine: EngineView }) {
    const { engine } = props;
    if (engine.suspendedBy === 'owner') {
        return <Banner tone="danger">{m.engine_revoked_body()}</Banner>;
    }
    if (engine.status === 'suspended') {
        return (
            <Banner tone="danger">
                <span className="flex flex-col gap-1">
                    <span>{m.engine_suspended_body()}</span>
                    <span>
                        {m.engine_suspended_contact()} <AbuseContactLink />.{' '}
                        <Link to="/abuse">{m.engine_suspended_policy()}</Link>
                    </span>
                </span>
            </Banner>
        );
    }
    if (engine.status === 'unknown') {
        return <Banner tone="info">{m.engine_status_unknown_body()}</Banner>;
    }
    return engine.status === 'offline' ? <OfflineHint /> : null;
}

/** Name, status, when it was last heard from and what it runs, with the one thing to do: open it. */
function Summary(props: { readonly engine: EngineView; readonly canRename: boolean }) {
    const { engine } = props;
    const now = useNowFor(engine);
    const name = engineLabel(engine);
    const update = engine.heartbeat?.update ?? 'none';
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
                <h1 className={`${engine.label === null ? 'font-mono' : 'font-display'} text-2xl font-semibold`}>
                    {name}
                </h1>
                <EngineStatusBadge engine={engine} />
                {props.canRename ? <RenameEngineButton engine={engine} /> : null}
            </div>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted">
                <span>
                    {m.engine_field_last_seen()} <LastSeen engine={engine} now={now} />
                </span>
                <span>
                    {m.engine_summary_version({ version: engine.heartbeat?.version ?? engine.registeredVersion })}
                    {update === 'none' ? null : ` · ${updateStateLabel(update)}`}
                </span>
                <EngineReachability engine={engine} />
            </p>
            {engine.status === 'suspended' ? null : (
                <div>
                    <EngineOpenLink name={name} hostname={engine.hostname} variant="primary" size="md" prominent />
                </div>
            )}
        </div>
    );
}

function EngineDetail(props: {
    readonly engine: EngineView;
    readonly canRevoke: boolean;
    readonly canRename: boolean;
}) {
    const { engine } = props;
    const formatters = useLocale();
    const name = engineLabel(engine);
    return (
        <>
            <Summary engine={engine} canRename={props.canRename} />
            <StatusNotice engine={engine} />
            <Card title={m.engine_identity_title()}>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <TrustMark
                            fingerprint={deriveEngineFingerprint(engine.engineId)}
                            state="verified"
                            size="lg"
                            className="shrink-0"
                            label={m.engines_fingerprint_label({ name })}
                        />
                        <p className="text-sm">{m.engine_fingerprint_body()}</p>
                    </div>
                    <Fields
                        fields={[
                            [
                                m.engine_field_id(),
                                <CodeText
                                    value={engine.engineId}
                                    copyable
                                    copyLabel={m.engines_copy_id({ engineId: shortEngineId(engine.engineId) })}
                                />,
                            ],
                            [
                                m.engine_field_hostname(),
                                <CodeText
                                    value={engine.hostname}
                                    kind="hostname"
                                    copyable
                                    copyLabel={m.engines_copy_hostname()}
                                />,
                            ],
                            ...(engine.customHostnames.length === 0
                                ? []
                                : [
                                      [
                                          m.engine_field_custom_hostnames(),
                                          <ul className="flex flex-col gap-1">
                                              {engine.customHostnames.map((hostname) => (
                                                  <li key={hostname} className="font-mono">
                                                      {hostname}
                                                  </li>
                                              ))}
                                          </ul>,
                                      ] as const,
                                  ]),
                            [m.engine_field_mode(), modeLabel(engine.mode)],
                            [
                                m.engine_field_registered_version(),
                                <span className="font-mono">{engine.registeredVersion}</span>,
                            ],
                            [m.engine_field_created(), formatters.formatDateTime(new Date(engine.createdAt))],
                        ]}
                    />
                </div>
            </Card>
            <Card title={m.engine_heartbeat_title()}>
                {engine.heartbeat === null ? (
                    <p className="text-sm">{m.engine_heartbeat_none()}</p>
                ) : (
                    <details className="group flex flex-col gap-3">
                        <summary className="inline-flex cursor-pointer items-center gap-1 text-sm font-medium">
                            <ChevronRight
                                aria-hidden
                                className="size-4 group-open:rotate-90 motion-safe:transition-transform"
                            />
                            {m.engine_heartbeat_disclosure()}
                        </summary>
                        <div className="mt-3 flex flex-col gap-3">
                            <p className="text-sm text-text-muted">{m.engine_heartbeat_body()}</p>
                            <HeartbeatFields heartbeat={engine.heartbeat} />
                        </div>
                    </details>
                )}
            </Card>
            {props.canRevoke && engine.status !== 'suspended' ? <RevokeEngineCard engine={engine} /> : null}
        </>
    );
}

/** Not this organization's, or not an engine at all; the same answer either way, so IDs cannot be probed. */
function NotFound() {
    const session = useSession();
    return (
        <EmptyState
            icon={<SearchX aria-hidden />}
            title={m.engine_not_found_title()}
            description={session.memberships.length > 1 ? m.engine_not_found_other_org() : m.engine_not_found_body()}
            headingLevel={1}
            action={
                <ButtonLink to="/engines" variant="primary">
                    {m.engine_not_found_action()}
                </ButtonLink>
            }
        />
    );
}

/** `/engines/$engineId`: one engine's registry data, fingerprint, last heartbeat as received, and revocation. */
export function EngineDetailPage(props: { readonly engineId: string | null }) {
    const api = useApiClient();
    const session = useSession();
    const permissions = session.activeOrg.permissions;
    const canRead = permissions.includes(READ_PERMISSION);
    const engine = useQuery({
        ...engineQuery(api, props.engineId ?? ''),
        enabled: canRead && props.engineId !== null,
    });

    let content: ReactNode;
    if (!canRead) {
        content = <Banner tone="info">{m.engines_not_allowed()}</Banner>;
    } else if (props.engineId === null || problemCode(engine.error) === 'not-found') {
        content = <NotFound />;
    } else if (engine.data !== undefined) {
        content = (
            <EngineDetail
                engine={engine.data}
                canRevoke={permissions.includes(REVOKE_PERMISSION)}
                canRename={canRename(permissions)}
            />
        );
    } else if (engine.isError) {
        content = (
            <>
                <h1 className="sr-only">{m.engine_error()}</h1>
                <ErrorState
                    message={m.engine_error()}
                    onRetry={() => void engine.refetch()}
                    retrying={engine.isFetching}
                />
            </>
        );
    } else {
        content = (
            <div aria-busy="true" className="flex flex-col gap-3">
                <span className="sr-only" role="status">
                    {m.loading()}
                </span>
                <Skeleton shape="text" className="h-8 w-48" />
                <Skeleton shape="block" className="h-32 w-full" />
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-6">
            <BackLink />
            {content}
        </div>
    );
}
