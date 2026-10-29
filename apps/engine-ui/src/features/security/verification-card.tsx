import type { ReadSecurityOverview } from '@ptbk/engine-api';
import { Card, ErrorState, RelativeTime, Skeleton, useLocale } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { ChevronDown, CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { UI_VERSION } from '../../app/ui-version';
import { m } from '../../paraglide/messages';
import { HeartbeatDetails } from './heartbeat-details';
import {
    CertificateDetails,
    EngineDetails,
    HostnamesDetails,
    OutboundDetails,
    RelaysDetails,
    UiBundleDetails,
} from './security-details';
import { updateStatusLabel } from './security-labels';

type Overview = ReadSecurityOverview;

/** `attention` and `problem` rows open on their own, so nothing that needs a look hides behind a disclosure. */
export type CheckTone = 'ok' | 'info' | 'attention' | 'problem';

export interface Check {
    readonly id: string;
    readonly title: string;
    readonly tone: CheckTone;
    readonly summary: ReactNode;
    readonly details: ReactNode;
}

const TONE_ICON = {
    ok: <CircleCheck aria-hidden className="size-5 shrink-0 text-success" />,
    info: <Info aria-hidden className="size-5 shrink-0 text-text-muted" />,
    attention: <TriangleAlert aria-hidden className="size-5 shrink-0 text-warning" />,
    problem: <CircleAlert aria-hidden className="size-5 shrink-0 text-danger" />,
} as const satisfies Record<CheckTone, ReactNode>;

function uiBundleCheck(overview: Overview): Pick<Check, 'tone' | 'summary'> {
    if (overview.ui.lastUpdateCheck?.outcome === 'refused')
        return { tone: 'problem', summary: m.security_check_refused_title() };
    if (overview.ui.version !== UI_VERSION) return { tone: 'attention', summary: m.security_ui_mismatch_title() };
    return { tone: 'ok', summary: m.security_check_ui_ok({ version: overview.ui.version }) };
}

function certificateCheck(overview: Overview, formatDate: (date: Date) => string): Pick<Check, 'tone' | 'summary'> {
    const result = overview.tls.lastCtCheck?.result;
    if (result === 'unexpected-certificate') return { tone: 'problem', summary: m.security_ct_foreign_title() };
    if (result === 'failed') return { tone: 'attention', summary: m.security_ct_failed_title() };
    const date = formatDate(new Date(overview.tls.notAfter));
    return result === 'ok'
        ? { tone: 'ok', summary: m.security_check_tls_ok({ date }) }
        : { tone: 'info', summary: m.security_check_tls_unchecked({ date }) };
}

function relaysCheck({ relays }: Overview): Pick<Check, 'tone' | 'summary'> {
    if (relays.length === 0) return { tone: 'info', summary: m.security_relays_empty_body() };
    const connected = relays.filter(({ status }) => status === 'connected').length;
    return {
        tone: connected === relays.length ? 'ok' : 'attention',
        summary: m.security_check_relays({ connected: String(connected), count: relays.length }),
    };
}

function hostnamesCheck({ hostnames }: Overview): Pick<Check, 'tone' | 'summary'> {
    const fallback = hostnames.find(({ kind }) => kind === 'default')?.hostname ?? m.security_not_reported();
    const custom = hostnames.filter(({ kind }) => kind === 'custom').length;
    const failing = hostnames.some(
        ({ certificateStatus }) => certificateStatus === 'expired' || certificateStatus === 'error',
    );
    return {
        tone: failing ? 'attention' : 'info',
        summary:
            custom === 0
                ? m.security_check_hostnames_default({ hostname: fallback })
                : m.security_check_hostnames_custom({ hostname: fallback, count: custom }),
    };
}

function outboundCheck({ outboundDestinations }: Overview): Pick<Check, 'tone' | 'summary'> {
    return {
        tone: 'info',
        summary:
            outboundDestinations.length === 0
                ? m.security_outbound_empty()
                : m.security_check_outbound({ count: outboundDestinations.length }),
    };
}

function heartbeatCheck({ lastHeartbeat, clockSkew }: Overview): Pick<Check, 'tone' | 'summary'> {
    if (clockSkew !== null) return { tone: 'attention', summary: m.security_clock_skew_title() };
    if (lastHeartbeat === null) return { tone: 'info', summary: m.security_heartbeat_empty() };
    return {
        tone: 'ok',
        summary: (
            <>
                {m.security_check_heartbeat_sent()} <RelativeTime value={new Date(lastHeartbeat.sentAt)} />
            </>
        ),
    };
}

/** One row per claim the engine reports, summary first; the exact values sit in each row's details. */
export function securityChecks(overview: Overview, formatDate: (date: Date) => string): readonly Check[] {
    return [
        {
            id: 'engine',
            title: m.security_engine_title(),
            tone: 'info',
            summary: m.security_check_engine({
                version: overview.engine.version,
                update: updateStatusLabel(overview.update.status),
            }),
            details: <EngineDetails overview={overview} />,
        },
        {
            id: 'ui-bundle',
            title: m.security_ui_title(),
            ...uiBundleCheck(overview),
            details: <UiBundleDetails overview={overview} />,
        },
        {
            id: 'certificate',
            title: m.security_tls_title(),
            ...certificateCheck(overview, formatDate),
            details: <CertificateDetails overview={overview} />,
        },
        {
            id: 'relays',
            title: m.security_relays_title(),
            ...relaysCheck(overview),
            details: <RelaysDetails overview={overview} />,
        },
        {
            id: 'hostnames',
            title: m.security_hostnames_title(),
            ...hostnamesCheck(overview),
            details: <HostnamesDetails overview={overview} />,
        },
        {
            id: 'outbound',
            title: m.security_outbound_title(),
            ...outboundCheck(overview),
            details: <OutboundDetails overview={overview} />,
        },
        {
            id: 'heartbeat',
            title: m.security_heartbeat_title(),
            ...heartbeatCheck(overview),
            details: <HeartbeatDetails overview={overview} />,
        },
    ];
}

function CheckRow({ check }: { readonly check: Check }) {
    const titleId = useId();
    const needsLook = check.tone === 'attention' || check.tone === 'problem';
    return (
        <li id={`security-${check.id}`}>
            <section aria-labelledby={titleId}>
                <details className="group" open={needsLook}>
                    <summary className="flex cursor-pointer list-none items-start gap-3 rounded-small py-3 focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
                        {TONE_ICON[check.tone]}
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span id={titleId} className="font-medium">
                                {check.title}
                            </span>
                            <span className="text-sm break-words text-text-muted">{check.summary}</span>
                        </span>
                        <ChevronDown
                            aria-hidden
                            className="mt-0.5 size-4 shrink-0 text-text-muted group-open:rotate-180 motion-safe:transition-transform"
                        />
                    </summary>
                    <div className="pb-4 sm:ps-8">{check.details}</div>
                </details>
            </section>
        </li>
    );
}

/**
 * The engine's security claims as a checklist (spec, Transparency and verifiability 3): a one-line verdict per claim,
 * with the values exactly as the engine reports them one click away. Rows that need a look are open from the start.
 */
export function VerificationCard({ query }: { readonly query: UseQueryResult<Overview> }) {
    const locale = useLocale();
    let content: ReactNode;
    if (query.data !== undefined) {
        content = (
            <ul className="-my-3 flex flex-col divide-y divide-divider">
                {securityChecks(query.data, (date) => locale.formatDate(date)).map((check) => (
                    <CheckRow key={check.id} check={check} />
                ))}
            </ul>
        );
    } else if (query.isError) {
        content = (
            <ErrorState
                message={m.section_load_failed()}
                onRetry={() => {
                    void query.refetch();
                }}
                retrying={query.isFetching}
            />
        );
    } else {
        content = (
            <div aria-busy="true" className="flex flex-col gap-4">
                {Array.from({ length: 7 }, (_, index) => (
                    <Skeleton key={index} className="h-10 w-full" />
                ))}
            </div>
        );
    }
    return <Card title={m.security_checks_title()}>{content}</Card>;
}
