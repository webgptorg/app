import { IntegrationId } from '@ptbk/engine-api';
import type { AgentId, ReadIntegration } from '@ptbk/engine-api';
import { Badge, Banner, Card, EmptyState, ErrorState, Skeleton, useLocale } from '@ptbk/ui';
import { getRouteApi } from '@tanstack/react-router';
import { SearchX } from 'lucide-react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { ButtonLink, Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { BackLink, Page } from '../shell/page';
import { IntegrationActions } from './integration-actions';
import { IntegrationActivityList } from './integration-activity-list';
import { IntegrationConfig } from './integration-config';
import { IntegrationSecrets } from './integration-secrets';
import { IntegrationStatusBadge, needsAttention } from './integration-status';
import { IntegrationTools } from './integration-tools';
import { useIntegration } from './integrations-queries';
import { useAgentNames } from './use-agent-names';

const route = getRouteApi('/integrations/$integrationId');

function isNotFound(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.status === 404;
}

/** One integration: its status, settings, scopes, tools, secret references and recent activity. */
export function IntegrationDetailPage() {
    const integrationId = IntegrationId.safeParse(route.useParams().integrationId).data;
    return integrationId === undefined ? <IntegrationNotFound /> : <LoadedIntegration integrationId={integrationId} />;
}

function LoadedIntegration({ integrationId }: { readonly integrationId: IntegrationId }) {
    const integration = useIntegration(integrationId);
    if (integration.isPending) return <IntegrationDetailSkeleton />;
    if (integration.isError) {
        if (isNotFound(integration.error)) return <IntegrationNotFound />;
        return (
            <Page title={m.integration_title_loading()}>
                <ErrorState
                    message={m.integration_load_failed()}
                    onRetry={() => {
                        void integration.refetch();
                    }}
                    retrying={integration.isFetching}
                />
            </Page>
        );
    }
    return <IntegrationDetail integration={integration.data} />;
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

function DateTime({ at }: { readonly at: string | null }) {
    const locale = useLocale();
    if (at === null) return <span className="text-text-muted">{m.integration_never()}</span>;
    return <time dateTime={at}>{locale.formatDateTime(new Date(at))}</time>;
}

function AgentLink({ agentId }: { readonly agentId: AgentId }) {
    const name = useAgentNames().get(agentId);
    return (
        <Link to="/agents/$agentId" params={{ agentId }}>
            {name ?? agentId}
        </Link>
    );
}

/** The fix for the first secret the integration cannot use, on the Secrets page; nothing for who may not see secrets. */
function SecretFix({ secretRefs }: { readonly secretRefs: ReadIntegration['secretRefs'] }) {
    const { can } = usePermissions();
    const unresolved = secretRefs.find(({ state }) => state !== 'resolved');
    if (unresolved === undefined || !can('secrets.read')) return null;
    return (
        <Link to="/secrets" search={{ q: unresolved.name }} className="break-all">
            {unresolved.state === 'revoked'
                ? m.integration_secret_replace({ name: unresolved.name })
                : m.integration_secret_add({ name: unresolved.name })}
        </Link>
    );
}

function IntegrationDetail({ integration }: { readonly integration: ReadIntegration }) {
    return (
        <Page
            title={integration.name}
            documentTitle={[integration.name, m.integrations_title()]}
            back={<BackLink to="/integrations">{m.integration_back()}</BackLink>}
            actions={<IntegrationActions integration={integration} />}
        >
            {needsAttention(integration.status) && integration.statusDetail !== null ? (
                <Banner
                    tone={integration.status === 'error' ? 'danger' : 'warning'}
                    action={<SecretFix secretRefs={integration.secretRefs} />}
                >
                    {/* From the engine, possibly quoting a third party: text only. */}
                    <span className="break-words whitespace-pre-wrap">{integration.statusDetail}</span>
                </Banner>
            ) : null}
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                <Fact label={m.integration_fact_status()}>
                    <IntegrationStatusBadge status={integration.status} />
                </Fact>
                <Fact label={m.integration_fact_agent()}>
                    {integration.agentId === null ? (
                        m.integration_all_agents()
                    ) : (
                        <AgentLink agentId={integration.agentId} />
                    )}
                </Fact>
                <Fact label={m.integration_fact_last_activity()}>
                    <DateTime at={integration.lastActivityAt} />
                </Fact>
                <Fact label={m.integration_fact_updated()}>
                    <DateTime at={integration.updatedAt} />
                </Fact>
                {needsAttention(integration.status) || integration.statusDetail === null ? null : (
                    <Fact label={m.integration_fact_status_detail()}>{integration.statusDetail}</Fact>
                )}
            </dl>
            <IntegrationConfig integration={integration} />
            <Card title={m.integration_scopes_title()} titleLevel={2}>
                {integration.scopes.length === 0 ? (
                    <p className="text-sm text-text-muted">{m.integration_scopes_none()}</p>
                ) : (
                    <ul className="flex flex-wrap gap-2">
                        {integration.scopes.map((scope) => (
                            <li key={scope} className="max-w-full">
                                <Badge tone="neutral" className="max-w-full break-all">
                                    {scope}
                                </Badge>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
            <IntegrationTools tools={integration.tools} />
            <IntegrationSecrets secretRefs={integration.secretRefs} />
            <IntegrationActivityList integrationId={integration.id} lastActivityAt={integration.lastActivityAt} />
        </Page>
    );
}

function IntegrationDetailSkeleton() {
    return (
        <Page title={m.integration_title_loading()}>
            <div aria-busy="true" aria-label={m.integration_title_loading()} className="flex flex-col gap-4">
                <Skeleton shape="text" className="h-8 w-2/3" />
                <Skeleton shape="block" className="h-32 w-full" />
                <Skeleton shape="block" className="h-48 w-full" />
            </div>
        </Page>
    );
}

function IntegrationNotFound() {
    return (
        <Page title={m.integration_not_found_title()}>
            <EmptyState
                icon={<SearchX aria-hidden />}
                title={m.integration_not_found_title()}
                description={m.integration_not_found_body()}
                action={<ButtonLink to="/integrations">{m.integration_back()}</ButtonLink>}
            />
        </Page>
    );
}
