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

function AccountSection(props: { readonly license: LicenseView }) {
    const { navigate } = useBrowser();
    const formatters = useFormatters();
    const { link, manageUrl, checkedAt } = props.license;
    if (link === null) {
        return (
            <Section title={m.license_account_title()} divided={false} description={m.license_account_unlinked()}>
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
            </Section>
        );
    }
    const date = formatters.formatDate(new Date(link.linkedAt));
    return (
        <Section
            title={m.license_account_title()}
            divided={false}
            description={
                link.linkedByEmail === null
                    ? m.license_account_linked_unknown({ date })
                    : m.license_account_linked({ email: link.linkedByEmail, date })
            }
            actions={
                manageUrl === null ? null : <ExternalLink href={manageUrl}>{m.license_manage_action()}</ExternalLink>
            }
        >
            {checkedAt === null ? null : (
                <p className="text-sm text-text-muted">
                    {m.license_checked()} <RelativeTime value={new Date(checkedAt)} />
                </p>
            )}
        </Section>
    );
}

function Usage(props: { readonly label: string; readonly value: string; readonly covered: boolean }) {
    return (
        <div className="soft-surface flex flex-wrap items-center justify-between gap-2 p-4">
            <div className="flex flex-col gap-0.5">
                <span className="text-sm text-text-muted">{props.label}</span>
                <span className="text-lg font-medium tabular-nums">{props.value}</span>
            </div>
            <StatusPill tone={props.covered ? 'success' : 'warning'}>
                {props.covered ? m.license_covered() : m.license_not_covered()}
            </StatusPill>
        </div>
    );
}

function CoverageSection(props: { readonly coverage: NonNullable<LicenseView['coverage']> }) {
    const formatters = useFormatters();
    const { engines, people } = props.coverage;
    const used = formatters.formatNumber(engines.used);
    return (
        <Section title={m.license_coverage_title()}>
            <div className="grid gap-3 sm:grid-cols-2">
                <Usage
                    label={m.license_coverage_engines()}
                    value={
                        engines.capacity === null
                            ? m.license_coverage_used_unlimited({ used })
                            : m.license_coverage_used({ used, total: formatters.formatNumber(engines.capacity) })
                    }
                    covered={engines.covered >= engines.used}
                />
                <Usage
                    label={m.license_coverage_people()}
                    value={
                        people.limit === null
                            ? m.license_coverage_people_unlimited({ used: formatters.formatNumber(people.used) })
                            : m.license_coverage_people_limit({
                                  used: formatters.formatNumber(people.used),
                                  limit: formatters.formatNumber(people.limit),
                              })
                    }
                    covered={people.limit === null || people.used <= people.limit}
                />
            </div>
            <p className="text-sm text-text-muted">{m.license_unknown_usage()}</p>
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
                {view.state === 'unknown' && view.link !== null ? (
                    <Banner tone="info">{m.license_unknown_body()}</Banner>
                ) : null}
                <AccountSection license={view} />
                {view.coverage === null ? null : <CoverageSection coverage={view.coverage} />}
                {view.state === 'unknown' ? null : (
                    <Section title={m.license_grants_title()} count={active}>
                        {view.grants.length === 0 ? (
                            <p className="text-sm text-text-muted">{m.license_grants_empty()}</p>
                        ) : (
                            <ul className="flex flex-col gap-3">
                                {view.grants.map((grant) => (
                                    <GrantItem key={grant.id} grant={grant} />
                                ))}
                            </ul>
                        )}
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
