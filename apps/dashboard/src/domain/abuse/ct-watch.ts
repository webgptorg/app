import type { Hostname } from '@ptbk/protocol';

import { sha256Hex } from '../auth/secrets';
import type { Alert } from '../monitoring/alert-rules';
import type { MonitorStore } from '../monitoring/monitor-store';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { CtIssuance, CtLogSource, CtSourceName } from './ct-log-source';
import type { CtAlertReason, CtCertRecord, CtStore } from './ct-store';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Past the longest validity any CA may still issue (398 days), so a certificate is never seen as new twice. */
export const CT_RETENTION_MS = 400 * DAY_MS;
/** Per run; the rest are stored with their reasons and listed by the runbook's query. */
export const MAX_CT_ALERTS_PER_RUN = 20;

export interface CtWatchSettings {
    /** Issuers whose `O=` is one of these are expected; any other is `foreign-issuer`. */
    readonly allowedIssuers: readonly string[];
    /** More than `limit` certificates for one engine within `days` is unusual. */
    readonly issuanceSpike: { readonly limit: number; readonly days: number };
    /** Per source, so a slow one leaves the other its time. */
    readonly sourceTimeoutMs: number;
}

export interface CtWatchDeps {
    readonly engineDomain: Hostname;
    readonly sources: readonly CtLogSource[];
    readonly store: CtStore;
    readonly monitor: Pick<MonitorStore, 'raise'>;
    readonly settings: CtWatchSettings;
    readonly clock: Clock;
    readonly logger: Logger;
}

const REASON_RULES = {
    wildcard: 'ct-wildcard',
    'foreign-issuer': 'ct-foreign-issuer',
    'unknown-hostname': 'ct-unknown-hostname',
} as const satisfies Readonly<Record<CtAlertReason, Alert['rule']>>;

/** The `O` and `CN` of a distinguished name; sources format the rest differently. */
function issuerParts(issuer: string): { readonly organization: string | null; readonly commonName: string | null } {
    const part = (key: string): string | null => {
        const match = new RegExp(`(?:^|[,/]\\s*)${key}=("[^"]*"|[^,/]*)`).exec(issuer);
        return match?.[1] === undefined ? null : match[1].replace(/^"|"$/g, '').trim();
    };
    return { organization: part('O'), commonName: part('CN') };
}

/** The same for a precertificate and its certificate, and for one issuance seen in both sources. */
export async function issuanceKey(issuance: CtIssuance): Promise<string> {
    const { organization, commonName } = issuerParts(issuance.issuer);
    const issuer =
        organization === null && commonName === null ? issuance.issuer : `${organization ?? ''}|${commonName ?? ''}`;
    const names = [...issuance.hostnames].sort().join(',');
    return sha256Hex(`${issuer}\n${String(Math.floor(issuance.notBefore / 1000))}\n${names}`);
}

function withinDomain(name: string, domain: string): boolean {
    return name === domain || name.endsWith(`.${domain}`);
}

/** `<engineId>.<engine domain>` only; anything deeper or the bare domain is no engine's. */
function engineIdOf(name: string, domain: string): string | null {
    const label = name.endsWith(`.${domain}`) ? name.slice(0, -domain.length - 1) : '';
    return /^[a-z2-7]{26}$/.test(label) ? label : null;
}

function reasonsFor(
    issuance: CtIssuance,
    domain: string,
    registered: ReadonlySet<string>,
    allowedIssuers: readonly string[],
): readonly CtAlertReason[] {
    const ours = issuance.hostnames.filter((name) => withinDomain(name, domain));
    const reasons: CtAlertReason[] = [];
    if (ours.some((name) => name.startsWith('*.'))) reasons.push('wildcard');
    const { organization } = issuerParts(issuance.issuer);
    if (organization === null || !allowedIssuers.includes(organization)) reasons.push('foreign-issuer');
    if (ours.some((name) => !name.startsWith('*.') && !registered.has(name))) reasons.push('unknown-hostname');
    return reasons;
}

interface SourceRead {
    readonly source: CtSourceName;
    readonly issuances: readonly CtIssuance[];
    readonly cursor: string | null;
}

async function readSource(deps: CtWatchDeps, source: CtLogSource, signal: AbortSignal): Promise<SourceRead | null> {
    try {
        const cursor = await deps.store.cursor(source.name);
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(deps.settings.sourceTimeoutMs)]);
        const page = await source.read(deps.engineDomain, cursor, timeout);
        return { source: source.name, issuances: page.issuances, cursor: page.cursor };
    } catch (error) {
        deps.logger.warn('ct.source-failed', {
            source: source.name,
            problem: error instanceof Error ? error.name : 'unknown',
        });
        return null;
    }
}

/**
 * The CT watch (I-05), every 15 minutes: certificates for the engine domain from both sources, each judged once when
 * first seen. A wildcard, an issuer other than the expected ones, or a name under the engine domain that is no
 * registered engine's raises an alert per reason; so does an engine whose certificates pile up. One source failing
 * degrades the watch; both failing fails the run. Engines watch CT for their own key too; this is ours.
 */
export async function runCtWatch(deps: CtWatchDeps, signal: AbortSignal): Promise<void> {
    const at = deps.clock.nowMs();
    const domain = deps.engineDomain as string;
    const reads = (await Promise.all(deps.sources.map((source) => readSource(deps, source, signal)))).filter(
        (read): read is SourceRead => read !== null,
    );
    if (reads.length === 0 && deps.sources.length > 0) {
        throw new Error('every CT source failed');
    }

    const seen = new Map<string, { readonly issuance: CtIssuance; readonly source: CtSourceName }>();
    for (const read of reads) {
        for (const issuance of read.issuances) {
            const key = await issuanceKey(issuance);
            if (!seen.has(key)) seen.set(key, { issuance, source: read.source });
        }
    }
    const known = await deps.store.known([...seen.keys()]);
    const fresh = [...seen].filter(([key]) => !known.has(key));
    const candidates = [
        ...new Set(
            fresh.flatMap(([, { issuance }]) =>
                issuance.hostnames.filter((name) => withinDomain(name, domain) && !name.startsWith('*.')),
            ),
        ),
    ];
    const registered = await deps.store.registeredHostnames(candidates);
    const records: CtCertRecord[] = fresh.map(([key, { issuance, source }]) => ({
        issuanceSha256: key,
        source,
        firstSeenAt: at,
        notBefore: issuance.notBefore,
        hostnames: issuance.hostnames,
        issuer: issuance.issuer,
        alert: reasonsFor(issuance, domain, registered, deps.settings.allowedIssuers),
    }));
    await deps.store.insert(records);

    const alerts: Alert[] = records.flatMap((record) =>
        record.alert.map((reason) => ({
            rule: REASON_RULES[reason],
            subject: record.issuanceSha256,
            state: 'firing' as const,
            at,
            detail: { names: record.hostnames.length },
        })),
    );
    alerts.push(...(await issuanceSpikes(deps, records, at)));
    if (alerts.length > MAX_CT_ALERTS_PER_RUN) {
        deps.logger.warn('ct.alerts-capped', { alerts: alerts.length, sent: MAX_CT_ALERTS_PER_RUN });
    }
    await deps.monitor.raise(alerts.slice(0, MAX_CT_ALERTS_PER_RUN));

    for (const read of reads) {
        if (read.cursor !== null) await deps.store.saveCursor(read.source, read.cursor);
    }
    await deps.store.prune(at - CT_RETENTION_MS);
    deps.logger.info('ct.run', {
        sources: reads.length,
        certificates: records.length,
        flagged: records.filter((record) => record.alert.length > 0).length,
    });
}

/**
 * Fires once, when this run's certificates take an engine past the limit within the window. Counted by issuance time,
 * so certificates a source reports late (or a first run's backlog) count when they were issued, not when seen.
 */
async function issuanceSpikes(deps: CtWatchDeps, records: readonly CtCertRecord[], at: number): Promise<Alert[]> {
    const domain = deps.engineDomain as string;
    const { limit, days } = deps.settings.issuanceSpike;
    const since = at - days * DAY_MS;
    const added = new Map<string, number>();
    for (const record of records.filter((candidate) => candidate.notBefore >= since)) {
        for (const name of record.hostnames) {
            if (engineIdOf(name, domain) !== null) added.set(name, (added.get(name) ?? 0) + 1);
        }
    }
    const alerts: Alert[] = [];
    for (const [hostname, count] of added) {
        const total = await deps.store.countIssuedSince(hostname, since);
        if (total > limit && total - count <= limit) {
            alerts.push({
                rule: 'ct-issuance-spike',
                subject: engineIdOf(hostname, domain) as string,
                state: 'firing',
                at,
                detail: { certificates: total, days },
            });
        }
    }
    return alerts;
}
