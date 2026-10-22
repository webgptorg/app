import type { Hono } from 'hono';

import { readEngineOverview, readEngineOverviews, type EngineOverview } from '../../domain/engines/engine-overview';
import { revokeEngine } from '../../domain/engines/revoke-engine';
import type { EngineCreationPolicy } from '../../domain/registration/engine-creation-policy';
import { issueLinkCode } from '../../domain/registration/issue-link-code';
import { OWNER_REVOKED } from '../../domain/registration/engine-store';
import { apiRoutes, type EngineView } from '../../shared/api/routes';
import { LINK_CODE_PLACEHOLDER } from '../config';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

function engineView(overview: EngineOverview): EngineView {
    const { engine, snapshot } = overview;
    const seen = snapshot === null || snapshot.state === 'never-seen' ? null : snapshot;
    return {
        engineId: engine.engineId,
        hostname: engine.hostname,
        customHostnames: [...overview.customHostnames],
        mode: engine.mode,
        registeredVersion: engine.engineVersion,
        status: overview.status,
        suspendedBy: engine.status === 'active' ? null : engine.statusReason === OWNER_REVOKED ? 'owner' : 'platform',
        createdAt: engine.createdAt,
        lastSeenAt: seen?.lastSeenAt ?? null,
        // Both are null after the retention purge, which keeps only the state and the time last seen.
        heartbeat:
            seen === null || seen.payload === null || seen.lastSeq === null
                ? null
                : { seq: seen.lastSeq, ...seen.payload },
    };
}

/**
 * The engine routes of `/api` (D-03, D-06). The organization is always the session's active one, never a request field,
 * and every engine is read through the organization-scoped store before anything else is asked about it.
 */
export function bindEngineRoutes(
    router: Hono,
    mount: string,
    deps: Pick<
        DashboardDeps,
        | 'config'
        | 'clock'
        | 'random'
        | 'logger'
        | 'timer'
        | 'linkCodes'
        | 'engines'
        | 'engineStatus'
        | 'engineHostnames'
    > & {
        readonly policy: EngineCreationPolicy;
        readonly routes: RouteBinder;
    },
): void {
    const bind = deps.routes.bind.bind(deps.routes);

    bind(router, mount, apiRoutes.createLinkCode, async ({ request, session }) => {
        const outcome = await issueLinkCode(
            { ...deps, linkCodeTtlMs: deps.config.linkCodeTtlMs },
            { orgId: session.actor.orgId, userId: session.actor.userId },
            request.signal,
        );
        if (outcome.kind === 'issued') {
            return {
                kind: 'ok',
                body: {
                    linkCode: outcome.linkCode,
                    installCommand: deps.config.installCommand.replace(LINK_CODE_PLACEHOLDER, () => outcome.linkCode),
                    expiresAt: outcome.expiresAt,
                },
            };
        }
        switch (outcome.reason) {
            case 'not-entitled':
            case 'engine-limit':
                return { kind: 'problem', status: 403, code: outcome.reason };
            case 'rate-limited':
                return { kind: 'problem', status: 429, code: 'rate-limited' };
        }
    });

    bind(router, mount, apiRoutes.listEngines, async ({ session }) => {
        const engines = await deps.engines.listForOrg(session.actor.orgId);
        const overviews = await readEngineOverviews(deps, engines);
        return { kind: 'ok', body: { engines: overviews.map(engineView) } };
    });

    bind(router, mount, apiRoutes.getEngine, async ({ input, session }) => {
        const engine = await deps.engines.findInOrg(session.actor.orgId, input.params.engineId);
        if (engine === null) {
            return { kind: 'problem', status: 404, code: 'not-found' };
        }
        return { kind: 'ok', body: { engine: engineView(await readEngineOverview(deps, engine)) } };
    });

    bind(router, mount, apiRoutes.revokeEngine, async ({ input, session }) => {
        const { engineId } = input.params;
        const outcome = await revokeEngine(deps, session.actor, engineId);
        const engine = outcome === 'not-found' ? null : await deps.engines.findInOrg(session.actor.orgId, engineId);
        if (engine === null) {
            return { kind: 'problem', status: 404, code: 'not-found' };
        }
        return { kind: 'ok', body: { engine: engineView(await readEngineOverview(deps, engine)) } };
    });
}
