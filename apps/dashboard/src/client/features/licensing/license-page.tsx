import {
    Banner,
    Button,
    ErrorState,
    ExternalLink,
    RelativeTime,
    Section,
    Skeleton,
    StatusPill,
    useLocale as useFormatters,
} from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { m } from '../../../paraglide/messages';
import type { LicenseView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { licenseQuery } from '../../api/queries';
import { useBrowser } from '../../core/browser';

type Grant = LicenseView['grants'][number];
type Capabilities = Grant['capabilities'];

/** A full-page navigation: the server sets the handoff cookie and sends the browser on to ptbk.io. */
export const WEBSITE_ACCESS_START = '/api/website-access/start';

const CAPACITIES: readonly (readonly [Exclude<keyof Capabilities, 'remoteControl'>, () => string])[] = [
    ['engineProjects', () => m.license_cap_engine_projects()],
    ['controllingUsers', () => m.license_cap_controlling_users()],
    ['specialists', () => m.license_cap_specialists()],
    ['harnessInstances', () => m.license_cap_harness_instances()],
    ['browserProfiles', () => m.license_cap_browser_profiles()],
];

function grantState(grant: Grant, now: number): { readonly tone: StatusTone; readonly label: string } {
    if (grant.active) return { tone: 'success', label: m.license_grant_active() };
    return Date.parse(grant.validFrom) > now
        ? { tone: 'waiting', label: m.license_grant_upcoming() }
        : { tone: 'neutral', label: m.license_grant_expired() };
}

function GrantItem(props: { readonly grant: Grant }) {
    const { now } = useBrowser();
    const formatters = useFormatters();
    const { grant } = props;
    const from = formatters.formatDate(new Date(grant.validFrom));
    const validity =
        grant.validUntil === null
            ? m.license_grant_validity_open({ from })
            : m.license_grant_validity({ from, until: formatters.formatDate(new Date(grant.validUntil)) });
    const state = grantState(grant, now());
    return (
        <li className="soft-surface flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">{validity}</span>
                <StatusPill tone={state.tone}>{state.label}</StatusPill>
            </div>
            <dl
                aria-label={m.license_grant_label({ validity })}
                className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr_auto_1fr]"
            >
                {CAPACITIES.map(([key, label]) => {
                    const value = grant.capabilities[key];
                    return (
                        <div key={key} className="contents">
                            <dt className="text-text-muted">{label()}</dt>
                            <dd className="tabular-nums">
                                {value === null ? m.license_cap_unlimited() : formatters.formatNumber(value)}
                            </dd>
                        </div>
                    );
                })}
                <dt className="text-text-muted">{m.license_cap_remote_control()}</dt>
                <dd>{grant.capabilities.remoteControl ? m.license_cap_included() : m.license_cap_not_included()}</dd>
            </dl>
        </li>
    );
}

type Status = NonNullable<LicenseView['status']>;

/** No licence needs no pill: "No license" already says it. */
const STATUS: Readonly<
    Record<Exclude<Status, 'none'> | 'unreachable', { readonly tone: StatusTone; readonly label: () => string }>
> = {
    active: { tone: 'success', label: () => m.license_status_active() },
    trial: { tone: 'info', label: () => m.license_status_trial() },
    scheduled: { tone: 'waiting', label: () => m.license_status_scheduled() },
    expired: { tone: 'neutral', label: () => m.license_status_expired() },
    unreachable: { tone: 'neutral', label: () => m.license_status_unreachable() },
};

function statusKey(license: LicenseView): keyof typeof STATUS | 'none' {
    if (license.link === null) return 'none';
    return license.status ?? 'unreachable';
}

/** The website's plan name; without one, a plain name for what is active. */
function planName(license: LicenseView): string {
    if (license.label !== null) return license.label;
    const active = license.grants.filter((grant) => grant.active).length;
    if (active > 1) return m.license_plan_many({ count: active });
    return active === 1 ? m.license_plan_generic() : m.license_plan_none();
}

function termLine(license: LicenseView, formatDate: (date: Date) => string): string | null {
    const { term, status } = license;
    if (term === null) {
        return status === 'active' || status === 'trial' ? m.license_term_open() : null;
    }
    const date = formatDate(new Date(term.at));
    switch (term.kind) {
        case 'ends':
            return status === 'trial' ? m.license_term_trial_ends({ date }) : m.license_term_ends({ date });
        case 'ended':
            return m.license_term_ended({ date });
        case 'starts':
            return m.license_term_starts({ date });
    }
}

function Limit(props: { readonly label: string; readonly value: string; readonly shortfall: string | null }) {
    return (
        <div className="contents">
            <dt className="text-text-muted">{props.label}</dt>
            <dd className="flex flex-wrap items-center gap-2 tabular-nums">
                {props.value}
                {props.shortfall === null ? null : <StatusPill tone="warning">{props.shortfall}</StatusPill>}
            </dd>
        </div>
    );
}

function Limits(props: { readonly coverage: NonNullable<LicenseView['coverage']> }) {
    const formatters = useFormatters();
    const { engines, people } = props.coverage;
    const used = formatters.formatNumber(engines.used);
    return (
        <>
            <dl
                aria-label={m.license_limits_label()}
                className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm"
            >
                <Limit
                    label={m.license_coverage_engines()}
                    value={
                        engines.capacity === null
                            ? m.license_coverage_used_unlimited({ used })
                            : m.license_coverage_used({ used, total: formatters.formatNumber(engines.capacity) })
                    }
                    shortfall={
                        engines.covered >= engines.used
                            ? null
                            : m.license_engines_uncovered({
                                  count: formatters.formatNumber(engines.used - engines.covered),
                              })
                    }
                />
                <Limit
                    label={m.license_coverage_people()}
                    value={
                        people.limit === null
                            ? m.license_coverage_people_unlimited({ used: formatters.formatNumber(people.used) })
                            : m.license_coverage_people_limit({
                                  used: formatters.formatNumber(people.used),
                                  limit: formatters.formatNumber(people.limit),
                              })
                    }
                    shortfall={people.limit === null || people.used <= people.limit ? null : m.license_not_covered()}
                />
            </dl>
            <p className="meta">{m.license_unknown_usage()}</p>
        </>
    );
}

/**
 * Plan, state, term, limits against what the App counts, and the way to ptbk.io. Quiet in every state: a missing or
 * ended licence is information, never an alarm, and nothing here blocks anything.
 */
function StatusSection(props: { readonly license: LicenseView }) {
    const { navigate } = useBrowser();
    const formatters = useFormatters();
    const { license } = props;
    const key = statusKey(license);
    const status = key === 'none' ? null : STATUS[key];
    const term = termLine(license, (date) => formatters.formatDate(date));
    const unlinked = license.link === null;
    const title =
        key === 'none' ? m.license_plan_none() : key === 'unreachable' ? m.license_plan_generic() : planName(license);
    return (
        <Section
            title={m.license_status_title()}
            divided={false}
            actions={
                <ExternalLink href={license.manageUrl}>
                    {key === 'none' ? m.license_buy_action() : m.license_manage_action()}
                </ExternalLink>
            }
        >
            <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-lg font-medium">{title}</span>
                    {status === null ? null : <StatusPill tone={status.tone}>{status.label()}</StatusPill>}
                </div>
                {term === null ? null : <p className="text-sm text-text-muted">{term}</p>}
            </div>
            {unlinked ? (
                <>
                    <p className="text-sm text-text-muted">{m.license_account_unlinked()}</p>
                    <div>
                        <Button
                            variant="primary"
                            onClick={() => {
                                navigate(WEBSITE_ACCESS_START);
                            }}
                        >
                            {m.license_link_action()}
                        </Button>
                    </div>
                </>
            ) : null}
            {key === 'unreachable' ? <p className="text-sm text-text-muted">{m.license_unknown_body()}</p> : null}
            {license.coverage === null ? null : <Limits coverage={license.coverage} />}
        </Section>
    );
}

function AccountSection(props: { readonly link: NonNullable<LicenseView['link']>; readonly checkedAt: string | null }) {
    const formatters = useFormatters();
    const { link, checkedAt } = props;
    const date = formatters.formatDate(new Date(link.linkedAt));
    return (
        <Section
            title={m.license_account_title()}
            description={
                link.linkedByEmail === null
                    ? m.license_account_linked_unknown({ date })
                    : m.license_account_linked({ email: link.linkedByEmail, date })
            }
        >
            {checkedAt === null ? null : (
                <p className="meta">
                    {m.license_checked()} <RelativeTime value={new Date(checkedAt)} />
                </p>
            )}
        </Section>
    );
}

/** `/license` with billing `website` (ADR 0021): what the website's licences cover. Advisory only, never a gate. */
export function LicensePage() {
    const api = useApiClient();
    const license = useQuery(licenseQuery(api));

    function content() {
        if (license.isPending) {
            return (
                <div>
                    <span className="sr-only">{m.loading()}</span>
                    <Skeleton className="h-40 w-full" />
                </div>
            );
        }
        if (license.isError) {
            return (
                <ErrorState
                    message={m.license_error()}
                    onRetry={() => void license.refetch()}
                    retrying={license.isFetching}
                />
            );
        }
        const view = license.data;
        const active = view.grants.filter((grant) => grant.active).length;
        return (
            <>
                {view.state === 'stale' ? (
                    <Banner tone="info" title={m.license_stale_title()}>
                        {m.license_stale_body()}
                    </Banner>
                ) : null}
                <StatusSection license={view} />
                {view.link === null ? null : <AccountSection link={view.link} checkedAt={view.checkedAt} />}
                {view.state === 'unknown' || view.grants.length === 0 ? null : (
                    <Section title={m.license_grants_title()} count={active}>
                        <ul className="flex flex-col gap-3">
                            {view.grants.map((grant) => (
                                <GrantItem key={grant.id} grant={grant} />
                            ))}
                        </ul>
                    </Section>
                )}
            </>
        );
    }

    return (
        <div className="flex max-w-3xl flex-col gap-6">
            <div className="flex flex-col gap-2">
                <h1 className="font-display text-2xl font-semibold">{m.license_title()}</h1>
                <p className="text-text-muted">{m.license_intro()}</p>
            </div>
            {content()}
        </div>
    );
}
