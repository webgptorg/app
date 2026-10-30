import type { ReadIntegration } from '@ptbk/engine-api';
import { Card, CodeText, ExternalLink } from '@ptbk/ui';
import type { ReactNode } from 'react';

import { useBrowser } from '../../app/browser-context';
import { m } from '../../paraglide/messages';
import { safeLinkUrl } from '../../security/safe-url';
import { integrationKindLabel, kindNameOf } from './integration-status';

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

/**
 * A URL from the engine as text, and as a link only where `safeLinkUrl` allows one: an absolute http(s) URL to another
 * origin without credentials. Anything else (`javascript:`, a path into this UI) stays text without an `href`.
 */
function UrlText({ url }: { readonly url: string }) {
    const { location } = useBrowser();
    const href = safeLinkUrl(url, location.origin);
    // Long URLs have no spaces to wrap at; they break anywhere so the card never scrolls sideways.
    return href === null ? (
        <CodeText value={url} />
    ) : (
        // The text is the URL itself, so the host in brackets after it would only repeat it.
        <ExternalLink href={href} showHost={false} className="break-all">
            {url}
        </ExternalLink>
    );
}

/** The kind-specific settings: config values come from the engine and third parties, so they render as text only. */
export function IntegrationConfig({ integration }: { readonly integration: ReadIntegration }) {
    return (
        <Card title={m.integration_config_title()} titleLevel={2}>
            <dl className="grid gap-4 sm:grid-cols-2">
                <Fact label={m.integration_fact_kind()}>{integrationKindLabel(kindNameOf(integration))}</Fact>
                <ConfigFacts integration={integration} />
            </dl>
        </Card>
    );
}

function ConfigFacts({ integration }: { readonly integration: ReadIntegration }) {
    switch (integration.kind) {
        case 'mcp-server':
            return (
                <Fact label={m.integration_fact_url()}>
                    <UrlText url={integration.config.url} />
                </Fact>
            );
        case 'calendar':
            return (
                <>
                    <Fact label={m.integration_fact_provider()}>{integration.config.provider}</Fact>
                    <Fact label={m.integration_fact_account()}>{integration.config.account}</Fact>
                </>
            );
        case 'repository':
            return (
                <Fact label={m.integration_fact_repository()}>
                    <UrlText url={`https://github.com/${integration.config.repository}`} />
                </Fact>
            );
        case 'unknown':
            return (
                <Fact label={m.integration_fact_raw_kind()}>
                    <CodeText value={integration.rawKind} />
                    <p className="mt-1 text-sm text-text-muted">{m.integration_unknown_kind_body()}</p>
                </Fact>
            );
    }
}
