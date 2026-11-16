import type { ReadIntegration } from '@ptbk/engine-api';
import { CodeText, ExternalLink, Section, useLocale } from '@ptbk/ui';
import type { ReactNode } from 'react';

import { useBrowser } from '../../app/browser-context';
import { m } from '../../paraglide/messages';
import { safeLinkUrl } from '../../security/safe-url';
import { integrationKindLabel, kindNameOf, ScopePill } from './integration-status';

/** One property: its name quiet on the left, the value beside it. */
export function Property({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-x-6 py-1.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
            <dt className="text-sm text-text-subtle">{label}</dt>
            <dd className="min-w-0 text-sm break-words">{children}</dd>
        </div>
    );
}

function DateTime({ at }: { readonly at: string | null }) {
    const locale = useLocale();
    if (at === null) return <span className="text-text-muted">{m.integration_never()}</span>;
    return (
        <time dateTime={at} className="tabular-nums">
            {locale.formatDateTime(new Date(at))}
        </time>
    );
}

/**
 * A URL from the engine as text, and as a link only where `safeLinkUrl` allows one: an absolute http(s) URL to another
 * origin without credentials. Anything else (`javascript:`, a path into this UI) stays text without an `href`.
 */
function UrlText({
    url,
    text,
    showHost = false,
}: {
    readonly url: string;
    readonly text?: string;
    readonly showHost?: boolean;
}) {
    const { location } = useBrowser();
    const href = safeLinkUrl(url, location.origin);
    // Long URLs have no spaces to wrap at; they break anywhere so the page never scrolls sideways.
    return href === null ? (
        <CodeText value={url} />
    ) : (
        <ExternalLink href={href} showHost={showHost} className="break-all">
            {text ?? url}
        </ExternalLink>
    );
}

/**
 * The kind-specific settings, the scopes and when it was last used, as quiet property rows. Config values come from
 * the engine and third parties, so they render as text only.
 */
export function IntegrationSettings({ integration }: { readonly integration: ReadIntegration }) {
    return (
        <Section title={m.integration_config_title()}>
            <dl className="flex max-w-3xl flex-col">
                <Property label={m.integration_fact_kind()}>{integrationKindLabel(kindNameOf(integration))}</Property>
                <ConfigFacts integration={integration} />
                {integration.scopes.length === 0 ? null : (
                    <Property label={m.integration_scopes_title()}>
                        <ul className="flex flex-wrap gap-1">
                            {integration.scopes.map((scope) => (
                                <li key={scope} className="max-w-full">
                                    <ScopePill scope={scope} />
                                </li>
                            ))}
                        </ul>
                    </Property>
                )}
                <Property label={m.integration_fact_last_activity()}>
                    <DateTime at={integration.lastActivityAt} />
                </Property>
                <Property label={m.integration_fact_updated()}>
                    <DateTime at={integration.updatedAt} />
                </Property>
            </dl>
        </Section>
    );
}

function ConfigFacts({ integration }: { readonly integration: ReadIntegration }) {
    switch (integration.kind) {
        case 'mcp-server':
            return (
                <Property label={m.integration_fact_url()}>
                    {/* The text is the URL itself, so the host in brackets after it would only repeat it. */}
                    <UrlText url={integration.config.url} />
                </Property>
            );
        case 'calendar':
            return (
                <>
                    <Property label={m.integration_fact_provider()}>{integration.config.provider}</Property>
                    <Property label={m.integration_fact_account()}>{integration.config.account}</Property>
                </>
            );
        case 'repository':
            return (
                <Property label={m.integration_fact_repository()}>
                    <UrlText
                        url={`https://github.com/${integration.config.repository}`}
                        text={integration.config.repository}
                        showHost
                    />
                </Property>
            );
        case 'unknown':
            return (
                <Property label={m.integration_fact_raw_kind()}>
                    <CodeText value={integration.rawKind} />
                    <p className="mt-1 text-text-muted">{m.integration_unknown_kind_body()}</p>
                </Property>
            );
    }
}
