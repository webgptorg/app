import type { ReadSecurityOverview } from '@ptbk/engine-api';
import { Badge, CodeText, RelativeTime, StatusPill, useLocale } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';

import { UI_VERSION } from '../../app/ui-version';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { Facts } from './facts';
import { ReleaseLogEntry } from './release-log-entry';
import { HashValue, SecurityNote } from './security-parts';
import {
    certificateStatusLabel,
    checkOutcomeLabel,
    ctResultLabel,
    refusalReasonLabel,
    relayStatusLabel,
    revocationReasonLabel,
    updateStatusLabel,
} from './security-labels';
import type { RelayStatus } from './security-labels';

type Overview = ReadSecurityOverview;

export function DateTime({ value }: { readonly value: string }) {
    const locale = useLocale();
    return <time dateTime={value}>{locale.formatDateTime(new Date(value))}</time>;
}

export function EngineDetails({ overview: { engine, update } }: { readonly overview: Overview }) {
    return (
        <Facts
            facts={[
                { label: m.security_version(), value: <CodeText value={engine.version} /> },
                {
                    label: m.security_release_log(),
                    value: <ReleaseLogEntry logIndex={engine.releaseLogIndex} entryUuid={engine.releaseLogEntryUuid} />,
                },
                { label: m.security_update_status(), value: updateStatusLabel(update.status) },
                update.availableVersion === null
                    ? null
                    : {
                          label: m.security_update_version(),
                          value: <CodeText value={update.availableVersion} />,
                      },
                update.eligibleAt === null
                    ? null
                    : { label: m.security_update_earliest(), value: <DateTime value={update.eligibleAt} /> },
            ]}
        />
    );
}

function LastUpdateCheck({ check }: { readonly check: NonNullable<Overview['ui']['lastUpdateCheck']> }) {
    const reason = check.reason === null ? null : refusalReasonLabel(check.reason);
    const revocation = check.revocationReason === null ? null : revocationReasonLabel(check.revocationReason);
    const summary = (
        <>
            {checkOutcomeLabel(check.outcome)}
            {check.version === null ? null : (
                <>
                    {' '}
                    <CodeText value={check.version} />
                </>
            )}{' '}
            (<RelativeTime value={new Date(check.at)} />)
        </>
    );
    if (check.outcome !== 'refused') return <span>{summary}</span>;
    return (
        <SecurityNote tone="danger">
            <span className="flex flex-col gap-1">
                <span className="font-medium">{summary}</span>
                {reason === null ? null : <span>{m.security_check_reason({ reason })}</span>}
                {revocation === null ? null : <span>{m.security_check_revocation({ reason: revocation })}</span>}
                <span className="text-text-muted">{m.security_check_refused_body()}</span>
            </span>
        </SecurityNote>
    );
}

export function UiBundleDetails({ overview: { ui } }: { readonly overview: Overview }) {
    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">{m.security_ui_hint()}</p>
            {ui.version === UI_VERSION ? null : (
                <SecurityNote tone="warning">
                    {m.security_ui_mismatch_body({ served: ui.version, compiled: UI_VERSION })}
                </SecurityNote>
            )}
            <Facts
                facts={[
                    { label: m.security_ui_served_version(), value: <CodeText value={ui.version} /> },
                    { label: m.security_ui_compiled_version(), value: <CodeText value={UI_VERSION} /> },
                    {
                        label: m.security_sha256(),
                        value: <HashValue value={ui.bundleSha256} copyLabel={m.security_copy_bundle_hash()} />,
                    },
                    {
                        label: m.security_release_log(),
                        value: <ReleaseLogEntry logIndex={ui.releaseLogIndex} entryUuid={ui.releaseLogEntryUuid} />,
                    },
                    {
                        label: m.security_ui_last_check(),
                        value:
                            ui.lastUpdateCheck === null ? (
                                m.security_not_reported()
                            ) : (
                                <LastUpdateCheck check={ui.lastUpdateCheck} />
                            ),
                    },
                ]}
            />
        </div>
    );
}

export function CertificateDetails({ overview: { tls } }: { readonly overview: Overview }) {
    const check = tls.lastCtCheck;
    // Whoever may change the engine is the one who has to act, so only they get the remedy; everyone else gets a person.
    const canActOnEngine = usePermissions().can('settings.manage');
    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">{m.security_tls_hint()}</p>
            {check?.result === 'unexpected-certificate' ? (
                <SecurityNote tone="danger">
                    <span className="flex flex-col gap-2">
                        <span>
                            {canActOnEngine
                                ? m.security_ct_foreign_manager_body()
                                : m.security_ct_foreign_member_body()}
                        </span>
                        {check.unexpectedCertificates.length === 0 ? null : (
                            <ul className="flex flex-col gap-2">
                                {check.unexpectedCertificates.map((certificate) => (
                                    <li key={certificate.sha256} className="flex min-w-0 flex-col gap-0.5">
                                        <HashValue
                                            value={certificate.sha256}
                                            copyLabel={m.security_copy_certificate_hash()}
                                        />
                                        <span>{m.security_ct_issuer({ issuer: certificate.issuer })}</span>
                                        <span className="text-text-muted tabular-nums">
                                            <DateTime value={certificate.notBefore} /> –{' '}
                                            <DateTime value={certificate.notAfter} />
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </span>
                </SecurityNote>
            ) : null}
            {check?.result === 'failed' ? (
                <SecurityNote tone="warning">{m.security_ct_failed_body()}</SecurityNote>
            ) : null}
            <Facts
                facts={[
                    {
                        label: m.security_certificate_sha256(),
                        value: (
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <HashValue
                                    value={tls.certificateSha256}
                                    copyLabel={m.security_copy_certificate_hash()}
                                />
                                <span className="text-xs text-text-muted">{m.security_certificate_compare()}</span>
                            </span>
                        ),
                    },
                    { label: m.security_certificate_not_after(), value: <DateTime value={tls.notAfter} /> },
                    {
                        label: m.security_ct_last_check(),
                        value:
                            check === null ? (
                                m.security_ct_never()
                            ) : (
                                <span>
                                    {ctResultLabel(check.result)} (<DateTime value={check.at} />)
                                </span>
                            ),
                    },
                ]}
            />
        </div>
    );
}

const RELAY_TONE: Readonly<Record<RelayStatus, StatusTone>> = {
    connected: 'success',
    connecting: 'waiting',
    disconnected: 'danger',
};

export function RelaysDetails({ overview: { relays } }: { readonly overview: Overview }) {
    const locale = useLocale();
    return relays.length === 0 ? (
        <p className="text-sm text-text-muted">{m.security_relays_empty_body()}</p>
    ) : (
        <ul className="flex flex-col divide-y divide-hairline">
            {relays.map((relay) => (
                <li key={relay.hostname} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
                    <span className="flex flex-wrap items-center gap-2">
                        <CodeText value={relay.hostname} />
                        <StatusPill tone={RELAY_TONE[relay.status]}>{relayStatusLabel(relay.status)}</StatusPill>
                    </span>
                    <span className="text-sm text-text-muted tabular-nums">
                        {m.security_relay_since()} <RelativeTime value={new Date(relay.since)} />
                        {' · '}
                        {relay.lastPingRttMs === null
                            ? m.security_relay_no_ping()
                            : m.security_relay_ping({ ms: locale.formatNumber(relay.lastPingRttMs) })}
                    </span>
                </li>
            ))}
        </ul>
    );
}

export function HostnamesDetails({ overview: { hostnames } }: { readonly overview: Overview }) {
    const custom = hostnames.filter(({ kind }) => kind === 'custom');
    return (
        <div className="flex flex-col gap-3">
            <ul className="flex flex-col divide-y divide-hairline">
                {hostnames.map((hostname) => (
                    <li key={hostname.hostname} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
                        <span className="flex flex-wrap items-center gap-2">
                            <CodeText value={hostname.hostname} copyable copyLabel={m.security_copy_hostname()} />
                            <Badge>
                                {hostname.kind === 'default'
                                    ? m.security_hostname_default()
                                    : m.security_hostname_custom()}
                            </Badge>
                        </span>
                        <span className="text-sm text-text-muted">
                            {m.security_hostname_certificate({
                                status: certificateStatusLabel(hostname.certificateStatus),
                            })}
                            {hostname.kind === 'custom'
                                ? ` · ${
                                      hostname.claimRegistered === null
                                          ? m.security_claim_unknown()
                                          : hostname.claimRegistered
                                            ? m.security_claim_registered()
                                            : m.security_claim_missing()
                                  }`
                                : null}
                        </span>
                    </li>
                ))}
            </ul>
            {custom.length === 0 ? (
                <p className="text-sm text-text-muted">{m.security_custom_domains_empty_body()}</p>
            ) : null}
        </div>
    );
}

export function OutboundDetails({ overview: { outboundDestinations } }: { readonly overview: Overview }) {
    return outboundDestinations.length === 0 ? (
        <p className="text-sm text-text-muted">{m.security_outbound_empty_body()}</p>
    ) : (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">{m.security_outbound_hint()}</p>
            <ul className="flex flex-col gap-2">
                {outboundDestinations.map((destination) => (
                    <li key={destination}>
                        <CodeText value={destination} />
                    </li>
                ))}
            </ul>
        </div>
    );
}
