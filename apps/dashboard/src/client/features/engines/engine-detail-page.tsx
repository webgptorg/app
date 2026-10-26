import { Banner, Card, CodeText, EmptyState, ErrorState, Skeleton, TrustMark, useLocale } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import type { EngineView, HeartbeatView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { engineQuery, problemCode } from '../../api/queries';
import { Link } from '../../core/link';
import { AbuseContactLink } from '../abuse/abuse-contact';
import { useSession } from '../session/use-session';
import { EngineOpenLink } from './engine-open-link';
import { EngineReachability, hasReachability } from './engine-reachability';
import { EngineStatusBadge } from './engine-status-badge';
import { cpuLoadLabel, modeLabel, shortEngineId, updateStateLabel, uptimeLabel } from './engine-labels';
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

/** A read-only list of facts; every value is plain text from our API. */
function Fields(props: { readonly fields: readonly (readonly [string, ReactNode])[] }) {
    return (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[minmax(10rem,max-content)_1fr]">
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
                [m.engine_heartbeat_seq(), <span className="font-mono">{formatters.formatNumber(heartbeat.seq)}</span>],
                [m.engine_heartbeat_sent(), formatters.formatDateTime(new Date(heartbeat.ts))],
                [m.engine_heartbeat_received(), formatters.formatDateTime(new Date(heartbeat.receivedAt))],
                [m.engine_heartbeat_version(), <span className="font-mono">{heartbeat.version}</span>],
                [m.engine_heartbeat_uptime(), uptimeLabel(heartbeat.uptimeS)],
                [m.engine_heartbeat_disk(), percent(heartbeat.diskPct)],
                [m.engine_heartbeat_ram(), percent(heartbeat.ramPct)],
                [m.engine_heartbeat_cpu(), cpuLoadLabel(heartbeat.cpuLoad)],
                [m.engine_heartbeat_update(), updateStateLabel(heartbeat.update)],
                [m.engine_heartbeat_agents(), formatters.formatNumber(heartbeat.agents)],
                [m.engine_heartbeat_members(), formatters.formatNumber(heartbeat.members)],
            ]}
        />
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
    return engine.status === 'unknown' ? <Banner tone="info">{m.engine_status_unknown_body()}</Banner> : null;
}

function EngineDetail(props: { readonly engine: EngineView; readonly canRevoke: boolean }) {
    const { engine } = props;
    const formatters = useLocale();
    const now = useNowFor(engine);
    return (
        <>
            <div className="flex flex-wrap items-center gap-3">
                <h1 className="font-display text-2xl font-semibold">
                    {m.engine_title({ shortId: shortEngineId(engine.engineId) })}
                </h1>
                <EngineStatusBadge engine={engine} />
            </div>
            <StatusNotice engine={engine} />
            <Card title={m.engine_fingerprint_title()}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <TrustMark
                        engineId={engine.engineId}
                        state="verified"
                        size="lg"
                        label={m.engines_fingerprint_label({ shortId: shortEngineId(engine.engineId) })}
                    />
                    <p className="text-sm">{m.engine_fingerprint_body()}</p>
                </div>
            </Card>
            <Card title={m.engine_details_title()}>
                <Fields
                    fields={[
                        [m.engine_field_status(), <EngineStatusBadge engine={engine} />],
                        ...(hasReachability(engine)
                            ? [[m.engine_field_reachability(), <EngineReachability engine={engine} />] as const]
                            : []),
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
                            <span className="flex flex-wrap items-center gap-2">
                                <CodeText value={engine.hostname} copyable copyLabel={m.engines_copy_hostname()} />
                                {engine.status === 'suspended' ? null : (
                                    <EngineOpenLink engineId={engine.engineId} hostname={engine.hostname} />
                                )}
                            </span>,
                        ],
                        [
                            m.engine_field_custom_hostnames(),
                            engine.customHostnames.length === 0 ? (
                                m.engine_no_custom_hostnames()
                            ) : (
                                <ul className="flex flex-col gap-1">
                                    {engine.customHostnames.map((hostname) => (
                                        <li key={hostname} className="font-mono">
                                            {hostname}
                                        </li>
                                    ))}
                                </ul>
                            ),
                        ],
                        [m.engine_field_mode(), modeLabel(engine.mode)],
                        [
                            m.engine_field_registered_version(),
                            <span className="font-mono">{engine.registeredVersion}</span>,
                        ],
                        [m.engine_field_created(), formatters.formatDateTime(new Date(engine.createdAt))],
                        [m.engine_field_last_seen(), <LastSeen engine={engine} now={now} />],
                    ]}
                />
            </Card>
            <Card title={m.engine_heartbeat_title()}>
                <div className="flex flex-col gap-3">
                    <p className="text-sm text-text-muted">{m.engine_heartbeat_body()}</p>
                    {engine.heartbeat === null ? (
                        <p className="text-sm">{m.engine_heartbeat_none()}</p>
                    ) : (
                        <HeartbeatFields heartbeat={engine.heartbeat} />
                    )}
                </div>
            </Card>
            {props.canRevoke && engine.status !== 'suspended' ? <RevokeEngineCard engine={engine} /> : null}
        </>
    );
}

function NotFound() {
    return (
        <EmptyState
            icon={<SearchX aria-hidden />}
            title={m.engine_not_found_title()}
            description={m.engine_not_found_body()}
            headingLevel={1}
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
        content = <EngineDetail engine={engine.data} canRevoke={permissions.includes(REVOKE_PERMISSION)} />;
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
