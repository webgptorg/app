import type { ReadSecurityOverview } from '@ptbk/engine-api';
import { deriveEngineFingerprint } from '@ptbk/protocol';
import { CodeText, Skeleton, StatusDot, TrustMark } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { UI_VERSION } from '../../app/ui-version';
import { m } from '../../paraglide/messages';
import { engineInfoQueryOptions } from '../engine/engine-queries';
import { dashboardLinks } from '../shell/dashboard-links';
import { Facts } from './facts';
import { ExternalChip } from './security-parts';
import { TRUST_PANEL_HASH } from './trust-panel-hash';

interface Seal {
    readonly verified: boolean;
    readonly label: string | undefined;
    /** The same verdict in words, so the seal's colour and motion never carry it alone. */
    readonly status: string;
    readonly tone: StatusTone;
}

/**
 * Sealed only when the checks this page can read hold up. Without `security.read` there are none, so the seal stays
 * the engine's identity and its name claims no verification.
 */
function sealOf(overview: UseQueryResult<ReadSecurityOverview> | null): Seal {
    if (overview === null)
        return {
            verified: true,
            label: m.security_trust_identity(),
            status: m.security_trust_status_no_access(),
            tone: 'neutral',
        };
    const data = overview.data;
    if (data === undefined)
        return overview.isError
            ? {
                  verified: false,
                  label: m.security_trust_unverified(),
                  status: m.security_trust_status_unavailable(),
                  tone: 'neutral',
              }
            : { verified: false, label: undefined, status: m.security_trust_status_checking(), tone: 'waiting' };
    const problem = problemOf(data);
    return problem === undefined
        ? { verified: true, label: undefined, status: m.security_trust_status_verified(), tone: 'success' }
        : { verified: false, label: problem, status: m.security_trust_status_unverified(), tone: 'warning' };
}

function problemOf(data: ReadSecurityOverview): string | undefined {
    if (data.ui.version !== UI_VERSION) return m.security_trust_mismatch();
    if (data.ui.releaseLogIndex === null) return m.security_trust_unlogged();
    if (data.tls.lastCtCheck?.result === 'unexpected-certificate') return m.security_ct_foreign_title();
    return undefined;
}

/**
 * The engine's identity for every member. With `security.read` (`overview` set) the seal also reflects the checks
 * (`sealOf`); without it, the engine's own hostname stands in for the reported one.
 */
export function TrustPanel({ overview }: { readonly overview: UseQueryResult<ReadSecurityOverview> | null }) {
    const { data: engine } = useSuspenseQuery(engineInfoQueryOptions(useEngineApi()));
    const heading = useRef<HTMLHeadingElement>(null);
    const hash = useLocation({ select: (location) => location.hash });
    useEffect(() => {
        if (hash === TRUST_PANEL_HASH) heading.current?.focus();
    }, [hash]);

    // Shown as verifying for the first frame even when the data is cached, so the seal is drawn once on every visit.
    const [settled, setSettled] = useState(false);
    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            setSettled(true);
        });
        return () => {
            cancelAnimationFrame(frame);
        };
    }, []);
    const seal = sealOf(overview);
    const verified = settled && seal.verified;
    const label = seal.label;
    const explanation = dashboardLinks(engine.dashboardUrl).trust;
    const defaultHostname =
        overview === null ? engine.hostname : overview.data?.hostnames.find(({ kind }) => kind === 'default')?.hostname;

    return (
        <section
            id={TRUST_PANEL_HASH}
            aria-labelledby="trust-panel-title"
            className="flex flex-col items-center gap-6 py-2 text-center sm:flex-row sm:items-start sm:gap-10 sm:text-start"
        >
            <TrustMark
                fingerprint={engine.engineId === null ? null : deriveEngineFingerprint(engine.engineId)}
                state={verified ? 'verified' : 'verifying'}
                size="lg"
                {...(label === undefined ? {} : { label })}
                className="shrink-0 flex-col sm:flex-col"
            />
            <div className="flex w-full min-w-0 flex-col items-center gap-3 sm:items-start">
                <h2
                    id="trust-panel-title"
                    ref={heading}
                    tabIndex={-1}
                    className="text-lg font-semibold tracking-heading text-balance"
                >
                    {m.security_trust_headline()}
                </h2>
                {/* A dot and words, not a pill: some verdicts are a sentence and must wrap, never truncate. */}
                <p className="flex items-baseline gap-2 text-sm font-medium">
                    <StatusDot tone={seal.tone} className="relative -top-px" />
                    <span>{seal.status}</span>
                </p>
                <p className="max-w-prose text-sm text-text-muted">
                    {engine.engineId === null ? m.security_trust_no_fingerprint() : m.security_trust_compare()}
                </p>
                <div className="w-full text-start">
                    <Facts
                        facts={[
                            engine.engineId === null
                                ? null
                                : {
                                      label: m.security_engine_id(),
                                      value: (
                                          <CodeText
                                              value={engine.engineId}
                                              copyable
                                              copyLabel={m.security_copy_engine_id()}
                                          />
                                      ),
                                  },
                            {
                                label: overview === null ? m.security_hostname() : m.security_default_hostname(),
                                value:
                                    defaultHostname === undefined ? (
                                        overview?.isError === true ? (
                                            m.security_not_reported()
                                        ) : (
                                            <Skeleton className="h-5 w-48" />
                                        )
                                    ) : (
                                        <CodeText
                                            value={defaultHostname}
                                            copyable
                                            copyLabel={m.security_copy_hostname()}
                                        />
                                    ),
                            },
                        ]}
                    />
                </div>
                {explanation === null ? null : (
                    <ExternalChip href={explanation}>{m.security_trust_explained()}</ExternalChip>
                )}
            </div>
        </section>
    );
}
