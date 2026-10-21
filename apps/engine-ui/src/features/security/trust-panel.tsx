import type { ReadSecurityOverview } from '@ptbk/engine-api';
import { CodeText, Skeleton, TrustMark } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { UI_VERSION } from '../../app/ui-version';
import { m } from '../../paraglide/messages';
import { engineInfoQueryOptions } from '../engine/engine-queries';
import { Facts } from './facts';
import { TRUST_PANEL_HASH } from './trust-panel-hash';

export function TrustPanel({ overview }: { readonly overview: UseQueryResult<ReadSecurityOverview> }) {
    const { data: engine } = useSuspenseQuery(engineInfoQueryOptions(useEngineApi()));
    const heading = useRef<HTMLHeadingElement>(null);
    const hash = useLocation({ select: (location) => location.hash });
    useEffect(() => {
        if (hash === TRUST_PANEL_HASH) heading.current?.focus();
    }, [hash]);

    const bundleMatches = overview.data?.ui.version === UI_VERSION;
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
    const verified = settled && bundleMatches;
    const label =
        overview.data === undefined
            ? overview.isError
                ? m.security_trust_unverified()
                : undefined
            : bundleMatches
              ? undefined
              : m.security_trust_mismatch();
    const defaultHostname = overview.data?.hostnames.find(({ kind }) => kind === 'default')?.hostname;

    return (
        <section
            id={TRUST_PANEL_HASH}
            aria-labelledby="trust-panel-title"
            className="flex flex-col gap-6 rounded-(--card-radius) border border-(--card-border) bg-(--card-bg) p-6 shadow-(--card-shadow) sm:flex-row sm:items-start"
        >
            <TrustMark
                engineId={engine.engineId}
                state={verified ? 'verified' : 'verifying'}
                size="lg"
                {...(label === undefined ? {} : { label })}
                className="shrink-0 flex-col sm:flex-col"
            />
            <div className="flex min-w-0 flex-col gap-3">
                <h2 id="trust-panel-title" ref={heading} tabIndex={-1} className="text-xl font-semibold">
                    {m.security_trust_headline()}
                </h2>
                <p className="text-sm text-text-muted">
                    {engine.engineId === null ? m.security_trust_no_fingerprint() : m.security_trust_compare()}
                </p>
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
                            label: m.security_default_hostname(),
                            value:
                                defaultHostname === undefined ? (
                                    overview.isError ? (
                                        m.security_not_reported()
                                    ) : (
                                        <Skeleton className="h-5 w-48" />
                                    )
                                ) : (
                                    <CodeText value={defaultHostname} copyable copyLabel={m.security_copy_hostname()} />
                                ),
                        },
                    ]}
                />
            </div>
        </section>
    );
}
