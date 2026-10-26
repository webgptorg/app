import type { ReadSecurityOverview } from '@ptbk/engine-api';
import { Banner, CodeText, CopyButton, EmptyState, Skeleton, useLocale } from '@ptbk/ui';
import type { UseQueryResult } from '@tanstack/react-query';

import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { Facts } from './facts';
import { SectionCard } from './section-card';

/** What each field of the heartbeat (C-03) tells the dashboard; the payload holds numbers and closed enums only. */
const FIELDS: readonly (readonly [string, () => string])[] = [
    ['v', m.security_heartbeat_field_v],
    ['engineId', m.security_heartbeat_field_engine_id],
    ['seq', m.security_heartbeat_field_seq],
    ['ts', m.security_heartbeat_field_ts],
    ['version', m.security_heartbeat_field_version],
    ['uptimeS', m.security_heartbeat_field_uptime],
    ['diskPct', m.security_heartbeat_field_disk],
    ['ramPct', m.security_heartbeat_field_ram],
    ['cpuLoad', m.security_heartbeat_field_cpu],
    ['update', m.security_heartbeat_field_update],
    ['agents', m.security_heartbeat_field_agents],
    ['members', m.security_heartbeat_field_members],
];

function ClockSkew({ skew }: { readonly skew: NonNullable<ReadSecurityOverview['clockSkew']> }) {
    const locale = useLocale();
    const seconds = locale.formatNumber(Math.abs(skew.seconds));
    return (
        <Banner tone="warning" title={m.security_clock_skew_title()}>
            {skew.seconds < 0 ? m.security_clock_behind({ seconds }) : m.security_clock_ahead({ seconds })}{' '}
            {m.security_clock_measured({ at: locale.formatDateTime(new Date(skew.measuredAt)) })}
        </Banner>
    );
}

export function HeartbeatSection({ query }: { readonly query: UseQueryResult<ReadSecurityOverview> }) {
    const locale = useLocale();
    return (
        <SectionCard
            title={m.security_heartbeat_title()}
            query={query}
            className="lg:col-span-2"
            skeleton={<Skeleton shape="block" className="h-32 w-full" />}
        >
            {({ lastHeartbeat, clockSkew }) => (
                <div className="flex flex-col gap-4">
                    {clockSkew === null ? null : <ClockSkew skew={clockSkew} />}
                    {lastHeartbeat === null ? (
                        <EmptyState
                            headingLevel={3}
                            title={m.security_heartbeat_empty()}
                            description={m.security_heartbeat_empty_body()}
                        />
                    ) : (
                        <>
                            <p className="text-sm text-text-muted">{m.security_heartbeat_hint()}</p>
                            <Facts
                                facts={[
                                    {
                                        label: m.security_heartbeat_sent(),
                                        value: (
                                            <time dateTime={lastHeartbeat.sentAt}>
                                                {locale.formatDateTime(new Date(lastHeartbeat.sentAt))}
                                            </time>
                                        ),
                                    },
                                    {
                                        label: m.security_heartbeat_signature(),
                                        value:
                                            lastHeartbeat.signature === null ? (
                                                m.security_not_reported()
                                            ) : (
                                                <CodeText
                                                    value={lastHeartbeat.signature}
                                                    copyable
                                                    copyLabel={m.security_copy_signature()}
                                                />
                                            ),
                                    },
                                ]}
                            />
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium" id="heartbeat-body-label">
                                        {m.security_heartbeat_body()}
                                    </span>
                                    <CopyButton value={lastHeartbeat.body} label={m.security_copy_heartbeat()} />
                                </div>
                                {/* The exact bytes sent, as text: never parsed and re-serialised. Lines may wrap after a
                                    comma, between fields, and only a single over-long value breaks inside itself. */}
                                <pre
                                    aria-labelledby="heartbeat-body-label"
                                    data-testid="heartbeat-body"
                                    className="rounded-control bg-(--code-text-bg) p-3 font-mono text-xs whitespace-pre-wrap break-words text-(--code-text-text)"
                                >
                                    <SoftBreaks text={lastHeartbeat.body} after="," />
                                </pre>
                            </div>
                        </>
                    )}
                    <details className="text-sm">
                        <summary className="cursor-pointer font-medium">{m.security_heartbeat_fields()}</summary>
                        <table className="mt-3 w-full text-start">
                            <caption className="sr-only">{m.security_heartbeat_fields()}</caption>
                            <thead>
                                <tr>
                                    <th scope="col" className="py-1 pe-4 text-start font-medium">
                                        {m.security_heartbeat_field()}
                                    </th>
                                    <th scope="col" className="py-1 text-start font-medium">
                                        {m.security_heartbeat_meaning()}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {FIELDS.map(([field, meaning]) => (
                                    <tr key={field} className="border-t border-divider align-top">
                                        <th scope="row" className="py-1 pe-4 text-start font-normal">
                                            <code className="font-mono">{field}</code>
                                        </th>
                                        <td className="py-1 text-text-muted">{meaning()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </details>
                </div>
            )}
        </SectionCard>
    );
}
