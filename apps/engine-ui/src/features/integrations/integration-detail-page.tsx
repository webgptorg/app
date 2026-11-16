import { IntegrationId } from '@ptbk/engine-api';
import type { ReadIntegration } from '@ptbk/engine-api';
import { Banner, EmptyState, ErrorState, Skeleton } from '@ptbk/ui';
import { getRouteApi } from '@tanstack/react-router';
import { SearchX } from 'lucide-react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { EntityChip } from '../entities/entity-chip';
import { Crumb, Page } from '../shell/page';
import { IntegrationActions } from './integration-actions';
import { IntegrationActivityList } from './integration-activity-list';
import { IntegrationSettings } from './integration-config';
import { IntegrationSecrets } from './integration-secrets';
import { IntegrationStatusBadge, needsAttention } from './integration-status';
import { IntegrationTools } from './integration-tools';
import { useIntegration } from './integrations-queries';
import { useAgents } from './use-agent-names';

const route = getRouteApi('/integrations/$integrationId');

function isNotFound(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.status === 404;
}

function IntegrationsCrumb() {
    return <Crumb to="/integrations">{m.integrations_title()}</Crumb>;
}

const BREADCRUMBS = [<IntegrationsCrumb key="integrations" />];

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
            <Page title={m.integration_title_loading()} breadcrumbs={BREADCRUMBS}>
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
        <div className="flex min-w-0 items-center">
            <dt className="sr-only">{label}</dt>
            <dd className="flex min-w-0 items-center">{children}</dd>
        </div>
    );
}

function IntegrationAgent({ agentId }: { readonly agentId: ReadIntegration['agentId'] }) {
    const agents = useAgents();
    const agent = agentId === null ? undefined : agents.get(agentId);
    if (agentId === null) return <span>{m.integration_all_agents()}</span>;
    return (
        <EntityChip
            kind="agent"
            id={agentId}
            name={agent?.name ?? agentId}
            {...(agent === undefined ? {} : { profile: agent.profile })}
        />
    );
}

/** Status and who may use it, in one quiet line under the title. */
function IntegrationFacts({ integration }: { readonly integration: ReadIntegration }) {
    return (
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-muted">
            <Fact label={m.integration_fact_status()}>
                <IntegrationStatusBadge status={integration.status} />
            </Fact>
            <Fact label={m.integration_fact_agent()}>
                <IntegrationAgent agentId={integration.agentId} />
            </Fact>
        </dl>
    );
}

function IntegrationDetail({ integration }: { readonly integration: ReadIntegration }) {
    return (
        <Page
            title={integration.name}
            documentTitle={[integration.name, m.integrations_title()]}
            breadcrumbs={BREADCRUMBS}
            actions={<IntegrationActions integration={integration} />}
        >
            <div className="flex flex-col gap-4">
                <IntegrationFacts integration={integration} />
                {integration.statusDetail === null ? null : needsAttention(integration.status) ? (
                    <Banner tone={integration.status === 'error' ? 'danger' : 'warning'}>
                        {/* From the engine, possibly quoting a third party: text only. */}
                        <span className="break-words whitespace-pre-wrap">{integration.statusDetail}</span>
                    </Banner>
                ) : (
                    <p className="max-w-prose text-sm break-words whitespace-pre-wrap text-text-muted">
                        {integration.statusDetail}
                    </p>
                )}
            </div>
            <IntegrationSettings integration={integration} />
            <IntegrationTools tools={integration.tools} />
            <IntegrationSecrets secretRefs={integration.secretRefs} />
            <IntegrationActivityList integrationId={integration.id} lastActivityAt={integration.lastActivityAt} />
        </Page>
    );
}

function IntegrationDetailSkeleton() {
    return (
        <Page title={m.integration_title_loading()} breadcrumbs={BREADCRUMBS}>
            <div aria-busy="true" aria-label={m.integration_title_loading()} className="flex flex-col gap-4">
                <Skeleton shape="text" className="h-6 w-1/3" />
                <Skeleton shape="block" className="h-32 w-full" />
                <Skeleton shape="block" className="h-48 w-full" />
            </div>
        </Page>
    );
}

function IntegrationNotFound() {
    return (
        <Page title={m.integration_not_found_title()} breadcrumbs={BREADCRUMBS}>
            <EmptyState
                icon={<SearchX aria-hidden />}
                title={m.integration_not_found_title()}
                description={m.integration_not_found_body()}
                action={<ButtonLink to="/integrations">{m.integration_back()}</ButtonLink>}
            />
        </Page>
    );
}
