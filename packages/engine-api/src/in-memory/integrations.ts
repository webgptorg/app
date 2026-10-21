import type { ActivityActor } from '../capabilities/activity';
import { Integration, IntegrationStatus } from '../capabilities/integrations';
import type { SecretRef } from '../capabilities/integrations';
import type { AgentId } from '../common';
import { IntegrationId } from '../common';
import { fail, invalid, liveAgent, memberActor, notFound, ok, page, recordActivity, sortBy, time } from './kit';
import type { EngineContext, HandlerContext, Handlers, HandlerResult } from './kit';

/** Engine-wide secrets serve every integration; agent secrets only that agent's. */
function resolveSecrets(ctx: EngineContext, names: readonly string[], agentId: AgentId | null): SecretRef[] {
    return [...new Set(names)].map((name) => {
        const candidates = [...ctx.state.secrets.values()].filter(
            (secret) =>
                secret.name === name &&
                (secret.scope.kind === 'engine' || (agentId !== null && secret.scope.agentId === agentId)),
        );
        const active = candidates.find((secret) => secret.status === 'active');
        if (active) return { name, secretId: active.id, state: 'resolved' };
        const revoked = candidates[0];
        return revoked ? { name, secretId: revoked.id, state: 'revoked' } : { name, secretId: null, state: 'missing' };
    });
}

/** Missing secrets need attention first; with every secret resolved, the engine's probe tests the connection. */
function connect(ctx: EngineContext, integration: Integration, secretRefs: readonly SecretRef[]): Integration {
    const unresolved = secretRefs.filter(({ state }) => state !== 'resolved').map(({ name }) => name);
    if (unresolved.length > 0) {
        return {
            ...integration,
            secretRefs: [...secretRefs],
            status: 'needs-attention',
            statusDetail: `Secrets not available: ${unresolved.join(', ')}.`,
        };
    }
    const probe = ctx.checks.probeIntegration({ ...integration, secretRefs: [...secretRefs] });
    return {
        ...integration,
        secretRefs: [...secretRefs],
        status: probe.status,
        statusDetail: probe.status === 'connected' ? null : probe.statusDetail.slice(0, 1024),
    };
}

function save(
    ctx: EngineContext,
    integration: Integration,
    previous: Integration | undefined,
    actor: ActivityActor,
): Integration {
    ctx.state.integrations.set(integration.id, integration);
    ctx.publish({ type: 'integration.changed', integrationId: integration.id, agentId: integration.agentId });
    if (integration.status !== previous?.status) {
        const ref = {
            agentId: integration.agentId,
            actor,
            integrationId: integration.id,
            name: integration.name,
        };
        if (integration.status === 'connected') recordActivity(ctx, { kind: 'integration.connected', ...ref });
        if (integration.status === 'needs-attention' || integration.status === 'error') {
            recordActivity(ctx, { kind: 'integration.error', ...ref, statusDetail: integration.statusDetail });
        }
    }
    return integration;
}

function found(ctx: EngineContext, integrationId: string): HandlerResult<Integration> {
    const integration = ctx.state.integrations.get(integrationId);
    return integration ? ok(integration) : notFound('integration');
}

function nameTaken(ctx: EngineContext, name: string, agentId: AgentId | null, except?: string): boolean {
    return [...ctx.state.integrations.values()].some(
        (integration) => integration.id !== except && integration.agentId === agentId && integration.name === name,
    );
}

function reconnect(ctx: HandlerContext, integrationId: string, force: boolean): HandlerResult<Integration> {
    const result = found(ctx, integrationId);
    if (result.kind === 'problem') return result;
    const integration = result.data;
    if (integration.status === 'disconnected' && !force) return ok(integration);
    const names = integration.secretRefs.map(({ name }) => name);
    const checked = connect(
        ctx,
        { ...integration, updatedAt: ctx.now() },
        resolveSecrets(ctx, names, integration.agentId),
    );
    return ok(save(ctx, checked, integration, memberActor(ctx)));
}

/** What the engine noticed on its own, e.g. a token that expired or a server that went away. */
export function setIntegrationStatus(
    ctx: EngineContext,
    integrationId: string,
    input: { readonly status: IntegrationStatus; readonly statusDetail?: string | null },
): Integration {
    const previous = ctx.state.integrations.get(integrationId);
    if (!previous) throw new Error(`No integration ${integrationId}`);
    const status = IntegrationStatus.parse(input.status);
    const updated = Integration.parse({
        ...previous,
        status,
        statusDetail: status === 'connected' ? null : (input.statusDetail ?? null),
        updatedAt: ctx.now(),
    });
    return save(ctx, updated, previous, { kind: 'system' });
}

export const INTEGRATION_HANDLERS: Pick<
    Handlers,
    | 'listIntegrations'
    | 'createIntegration'
    | 'connectCalendar'
    | 'getIntegration'
    | 'updateIntegration'
    | 'deleteIntegration'
    | 'enableIntegration'
    | 'disableIntegration'
    | 'checkIntegration'
> = {
    listIntegrations: ({ query }, ctx) => {
        const integrations = [...ctx.state.integrations.values()].filter(
            (integration) =>
                (query.agentId === undefined || integration.agentId === query.agentId) &&
                (query.kind === undefined || integration.kind === query.kind) &&
                (query.status === undefined || integration.status === query.status),
        );
        return page(
            integrations,
            sortBy('-createdAt', (integration) => time(integration.createdAt), true),
            query,
        );
    },
    createIntegration: ({ body }, ctx) => {
        const agentId = body.agentId ?? null;
        if (agentId !== null) {
            const agent = liveAgent(ctx, agentId);
            if (agent.kind === 'problem') return agent;
        }
        if (nameTaken(ctx, body.name, agentId)) return fail('name-taken');
        const now = ctx.now();
        const base = {
            id: ctx.newId(IntegrationId, 'integration'),
            agentId,
            name: body.name,
            status: 'disconnected' as const,
            statusDetail: null,
            scopes: [],
            secretRefs: [],
            tools: [],
            lastActivityAt: null,
            createdBy: ctx.member.id,
            createdAt: now,
            updatedAt: now,
        };
        const integration: Integration =
            body.kind === 'mcp-server'
                ? { ...base, kind: 'mcp-server', config: { url: body.url } }
                : {
                      ...base,
                      kind: 'repository',
                      scopes: ['contents:read'],
                      config: { provider: body.provider, repository: body.repository },
                  };
        const connected = connect(ctx, integration, resolveSecrets(ctx, body.secretNames ?? [], agentId));
        return ok(save(ctx, connected, undefined, memberActor(ctx)));
    },
    connectCalendar: ({ body }) => ok({ redirectPath: `/oauth/calendar/${body.provider}/start` }),
    getIntegration: ({ params }, ctx) => found(ctx, params.integrationId),
    updateIntegration: ({ params, body }, ctx) => {
        const result = found(ctx, params.integrationId);
        if (result.kind === 'problem') return result;
        const previous = result.data;
        if (body.url !== undefined && previous.kind !== 'mcp-server') {
            return invalid('body.url', 'Only MCP servers have a URL.');
        }
        if (body.name !== undefined && nameTaken(ctx, body.name, previous.agentId, previous.id)) {
            return fail('name-taken');
        }
        let updated: Integration = {
            ...previous,
            ...(body.name === undefined ? {} : { name: body.name }),
            updatedAt: ctx.now(),
        };
        if (updated.kind === 'mcp-server' && body.url !== undefined) {
            updated = { ...updated, config: { url: body.url } };
        }
        if (body.secretNames !== undefined) {
            const secretRefs = resolveSecrets(ctx, body.secretNames, updated.agentId);
            updated =
                updated.status === 'disconnected' ? { ...updated, secretRefs } : connect(ctx, updated, secretRefs);
        }
        return ok(save(ctx, updated, previous, memberActor(ctx)));
    },
    deleteIntegration: ({ params }, ctx) => {
        const result = found(ctx, params.integrationId);
        if (result.kind === 'problem') return result;
        ctx.state.integrations.delete(params.integrationId);
        ctx.publish({
            type: 'integration.changed',
            integrationId: params.integrationId,
            agentId: result.data.agentId,
        });
        return ok(null);
    },
    enableIntegration: ({ params }, ctx) => {
        const result = found(ctx, params.integrationId);
        if (result.kind === 'problem') return result;
        return result.data.status === 'disconnected' ? reconnect(ctx, params.integrationId, true) : result;
    },
    disableIntegration: ({ params }, ctx) => {
        const result = found(ctx, params.integrationId);
        if (result.kind === 'problem') return result;
        const integration = result.data;
        if (integration.status === 'disconnected') return result;
        return ok(
            save(
                ctx,
                { ...integration, status: 'disconnected', statusDetail: null, updatedAt: ctx.now() },
                integration,
                memberActor(ctx),
            ),
        );
    },
    checkIntegration: ({ params }, ctx) => reconnect(ctx, params.integrationId, false),
};
