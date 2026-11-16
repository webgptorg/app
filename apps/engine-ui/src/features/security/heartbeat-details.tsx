import type { ReadSecurityOverview } from '@ptbk/engine-api';
import { CopyButton, useLocale } from '@ptbk/ui';
import { ChevronRight } from 'lucide-react';

import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { Facts } from './facts';
import { HashValue, SecurityNote } from './security-parts';

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
        <SecurityNote tone="warning">
            {skew.seconds < 0 ? m.security_clock_behind({ seconds }) : m.security_clock_ahead({ seconds })}{' '}
            {m.security_clock_measured({ at: locale.formatDateTime(new Date(skew.measuredAt)) })}
        </SecurityNote>
    );
}

export function HeartbeatDetails({
    overview: { lastHeartbeat, clockSkew },
}: {
    readonly overview: ReadSecurityOverview;
}) {
    const locale = useLocale();
    return (
        <div className="flex flex-col gap-3">
            {clockSkew === null ? null : <ClockSkew skew={clockSkew} />}
            {lastHeartbeat === null ? (
                <p className="text-sm text-text-muted">{m.security_heartbeat_empty_body()}</p>
            ) : (
                <>
                    <p className="text-sm text-text-muted">{m.security_heartbeat_hint()}</p>
                    <Facts
                        facts={[
                            {
                                label: m.security_heartbeat_sent(),
                                value: (
                                    <time dateTime={lastHeartbeat.sentAt} className="tabular-nums">
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
                                        <HashValue
                                            value={lastHeartbeat.signature}
                                            copyLabel={m.security_copy_signature()}
                                        />
                                    ),
                            },
                        ]}
                    />
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-sm text-text-subtle" id="heartbeat-body-label">
                                {m.security_heartbeat_body()}
                            </span>
                            <CopyButton value={lastHeartbeat.body} label={m.security_copy_heartbeat()} />
                        </div>
                        {/* The exact bytes sent, as text: never parsed and re-serialised. Lines may wrap after a
                                    comma, between fields, and only a single over-long value breaks inside itself. */}
                        <pre
                            aria-labelledby="heartbeat-body-label"
                            data-testid="heartbeat-body"
                            className="rounded-control bg-neutral-soft px-3.5 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-text"
                        >
                            <SoftBreaks text={lastHeartbeat.body} after="," />
                        </pre>
                    </div>
                </>
            )}
            <details className="group/fields text-sm">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-small text-text-muted hover:text-text [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                        aria-hidden
                        className="size-4 shrink-0 group-open/fields:rotate-90 motion-safe:transition-transform motion-safe:duration-(--motion-state)"
                    />
                    {m.security_heartbeat_fields()}
                </summary>
                <table className="mt-2 w-full max-w-2xl text-start">
                    <caption className="sr-only">{m.security_heartbeat_fields()}</caption>
                    <thead>
                        <tr>
                            <th scope="col" className="py-1.5 pe-6 text-start text-xs font-medium text-text-subtle">
                                {m.security_heartbeat_field()}
                            </th>
                            <th scope="col" className="py-1.5 text-start text-xs font-medium text-text-subtle">
                                {m.security_heartbeat_meaning()}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {FIELDS.map(([field, meaning]) => (
                            <tr key={field} className="border-t border-hairline align-top">
                                <th scope="row" className="py-1.5 pe-6 text-start font-normal">
                                    <code className="font-mono text-xs">{field}</code>
                                </th>
                                <td className="py-1.5 text-text-muted">{meaning()}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </details>
        </div>
    );
}
