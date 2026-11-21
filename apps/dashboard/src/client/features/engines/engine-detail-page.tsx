import { deriveEngineFingerprint } from '@ptbk/protocol';
import {
    Banner,
    Button,
    CodeText,
    EmptyState,
    ErrorState,
    ExternalLink,
    Section,
    Skeleton,
    TrustMark,
    useLocale,
} from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, SearchX, UserPlus } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import type { EngineView, HeartbeatView } from '../../../shared/api/routes';
import { engineLabel, shortEngineId } from '../../../shared/engine-label';
import { useApiClient } from '../../api/api-client-context';
import { engineQuery, installGuideQuery, problemCode } from '../../api/queries';
import { ButtonLink, Link } from '../../core/link';
import { AbuseContactLink } from '../abuse/abuse-contact';
import { Crumb, Page } from '../shell/page';
import { useSession } from '../session/use-session';
import { OpenTeamButton } from '../teams/open-team-button';
import { ENGINE_STATUS_COMMAND, troubleshootingLink } from './engine-guide';
import { EngineMark } from './engine-identity';
import { cpuLoadLabel, modeLabel, setupStateLabel, updateStateLabel } from './engine-labels';
import { canRename, RenameEngineButton } from './engine-name';
import { EngineOpenLink } from './engine-open-link';
import { EngineReachability } from './engine-reachability';
import { EngineStatusPill } from './engine-status-pill';
import { LastSeen, useNowFor } from './engine-values';
import { EngineActionMenu } from './revoke-engine';
import { useEngineTeam } from './use-engine-name';

// Loaded on first use: the dialog's form would otherwise put the engine page over its bundle budget, for an action
// only owners and admins take.
const InviteDialog = lazy(async () => ({ default: (await import('../teams/invite-dialog')).InviteDialog }));

const READ_PERMISSION = 'engine.read';
const REVOKE_PERMISSION = 'engine.revoke';
const INVITE_PERMISSION = 'org.members.manage';

/**
 * Read-only facts, a muted label before its value as in the peek cards; every value is plain text from our API. On a
 * phone the label sits over its value, so long IDs and hostnames get the whole width.
 */
function Fields(props: { readonly fields: readonly (readonly [string, ReactNode])[] }) {
    return (
        <dl className="grid grid-cols-1 gap-y-3 text-sm sm:grid-cols-[minmax(8rem,max-content)_minmax(0,1fr)] sm:gap-x-8 sm:gap-y-2.5">
            {props.fields.map(([label, value]) => (
                <div key={label} className="contents">
                    <dt className="text-text-muted">{label}</dt>
                    <dd className="-mt-2.5 min-w-0 tabular-nums sm:mt-0">{value}</dd>
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
                ...(heartbeat.setup === undefined
                    ? []
                    : [[m.engine_heartbeat_setup(), setupStateLabel(heartbeat.setup)] as const]),
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
function OfflineHint({ engine }: { readonly engine: EngineView }) {
    const pending = engine.heartbeat?.setup === 'pending';
    const command = pending ? `ptbk onboarding --id ${engine.engineId} --json` : ENGINE_STATUS_COMMAND;
    const guide = useQuery(installGuideQuery(useApiClient()));
    return (
        <Banner tone="warning" title={m.engine_offline_title()}>
            <span className="flex flex-col items-start gap-2">
                <span>{pending ? m.engine_offline_setup_hint() : m.engine_offline_hint()}</span>
                <CodeText value={command} copyable copyLabel={m.engine_offline_copy()} />
                {guide.data === undefined ? null : (
                    <ExternalLink href={troubleshootingLink(guide.data)}>
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
    if (engine.status === 'setup-pending') {
        // A line, not a banner: nothing is wrong, the owner only has a step left, and the action is right above.
        return <p className="text-sm text-text-muted">{m.engine_setup_pending_body()}</p>;
    }
    return engine.status === 'offline' ? <OfflineHint engine={engine} /> : null;
}

/** When it was last heard from, what it runs and how browsers reach it: the line under the title. */
function SummaryLine(props: { readonly engine: EngineView }) {
    const { engine } = props;
    const now = useNowFor(engine);
    const update = engine.heartbeat?.update ?? 'none';
    return (
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums">
            <EngineStatusPill engine={engine} />
            <span>
                {m.engine_field_last_seen()} <LastSeen engine={engine} now={now} />
            </span>
            <span>
                {m.engine_summary_version({ version: engine.heartbeat?.version ?? engine.registeredVersion })}
                {update === 'none' ? null : ` · ${updateStateLabel(update)}`}
            </span>
            <EngineReachability engine={engine} />
        </span>
    );
}

/**
 * Name, status, when it was last heard from and what it runs, with the one thing to do: open it. Someone in the team
 * opens with a ticket, as on the list: the plain link lands a person not yet approved at a sign-in they cannot pass.
 */
function EngineDetail(props: {
    readonly engine: EngineView;
    readonly canRevoke: boolean;
    readonly canRename: boolean;
    readonly canInvite: boolean;
}) {
    const { engine } = props;
    const formatters = useLocale();
    const { team, givenName } = useEngineTeam(engine.engineId, engine.hostname);
    const name = givenName ?? engineLabel(engine);
    const [inviting, setInviting] = useState(false);
    const [invitedOnce, setInvitedOnce] = useState(false);
    // People join an engine through its team; a suspended or revoked engine has nobody left to approve them.
    const inviteTeam = props.canInvite && engine.status !== 'suspended' ? team : undefined;
    return (
        <Page
            title={
                <span className={givenName === null && engine.label === null ? 'font-mono' : undefined}>{name}</span>
            }
            leading={<EngineMark engineId={engine.engineId} name={name} size="md" decorative />}
            breadcrumbs={[
                <Crumb key="engines" to="/engines">
                    {m.nav_teams()}
                </Crumb>,
            ]}
            description={<SummaryLine engine={engine} />}
            actions={
                <>
                    {props.canRename && givenName === null ? <RenameEngineButton engine={engine} /> : null}
                    {inviteTeam === undefined ? null : (
                        <Button
                            variant="secondary"
                            size="md"
                            onClick={() => {
                                setInviting(true);
                                setInvitedOnce(true);
                            }}
                        >
                            <UserPlus aria-hidden className="size-4" />
                            {m.invite_to_engine()}
                        </Button>
                    )}
                    {engine.status === 'suspended' ? null : team?.isMember === true ? (
                        <OpenTeamButton team={team} engine={engine} variant="primary" size="md" />
                    ) : (
                        <EngineOpenLink
                            name={name}
                            hostname={engine.hostname}
                            variant="primary"
                            size="md"
                            wording={engine.status === 'setup-pending' ? 'setup' : 'engine'}
                        />
                    )}
                    {props.canRevoke && engine.status !== 'suspended' ? (
                        <EngineActionMenu engine={engine} name={name} />
                    ) : null}
                </>
            }
        >
            <StatusNotice engine={engine} />
            <Section title={m.engine_identity_title()} divided={false}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                    <TrustMark
                        fingerprint={deriveEngineFingerprint(engine.engineId)}
                        state="verified"
                        size="lg"
                        className="shrink-0"
                        label={m.engines_fingerprint_label({ name })}
                    />
                    <p className="max-w-prose text-sm text-text-muted">{m.engine_fingerprint_body()}</p>
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
            </Section>
            <Section title={m.engine_heartbeat_title()}>
                {engine.heartbeat === null ? (
                    <p className="text-sm text-text-muted">{m.engine_heartbeat_none()}</p>
                ) : (
                    <details className="group flex flex-col gap-3">
                        <summary className="inline-flex cursor-pointer items-center gap-1 rounded-small text-sm font-medium">
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
            </Section>
            {inviteTeam === undefined || !invitedOnce ? null : (
                <Suspense fallback={null}>
                    <InviteDialog
                        open={inviting}
                        teamIds={[inviteTeam.teamId]}
                        engineName={name}
                        onClose={() => {
                            setInviting(false);
                        }}
                    />
                </Suspense>
            )}
        </Page>
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
                canInvite={permissions.includes(INVITE_PERMISSION)}
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
    return content;
}
