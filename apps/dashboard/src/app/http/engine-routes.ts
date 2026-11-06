import type { Hono } from 'hono';

import { readEngineOverview, readEngineOverviews, type EngineOverview } from '../../domain/engines/engine-overview';
import { renameEngine } from '../../domain/engines/rename-engine';
import { revokeEngine } from '../../domain/engines/revoke-engine';
import { visibleEngineIds } from '../../domain/teams/teams';
import type { EngineCreationPolicy } from '../../domain/registration/engine-creation-policy';
import { linkCodeIdSchema } from '../../domain/ids';
import { issueLinkCode } from '../../domain/registration/issue-link-code';
import { readLinkCodeStatus } from '../../domain/registration/read-link-code-status';
import { OWNER_REVOKED } from '../../domain/registration/engine-store';
import { apiRoutes, type EngineView, type LinkEligibilityView } from '../../shared/api/routes';
import type { DashboardDeps } from '../deps';
import { issuedLinkCodeView } from './link-code-view';
import type { RouteBinder } from './bind-route';

function engineView(overview: EngineOverview): EngineView {
    const { engine, snapshot } = overview;
    const seen = snapshot === null || snapshot.state === 'never-seen' ? null : snapshot;
    return {
        engineId: engine.engineId,
        label: engine.label,
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
        reachableRelays: overview.reachableRelays,
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
        | 'relayPresence'
        | 'teams'
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
                body: issuedLinkCodeView(deps.config, outcome),
            };
        }
        switch (outcome.reason) {
            case 'not-entitled':
            case 'engine-limit':
                return { kind: 'problem', status: 403, code: outcome.reason };
            case 'link-code-limit':
                return { kind: 'problem', status: 409, code: 'link-code-limit' };
            case 'rate-limited':
                return { kind: 'problem', status: 429, code: 'rate-limited' };
        }
    });

    bind(router, mount, apiRoutes.listLinkCodes, async ({ session }) => {
        const pending = await deps.linkCodes.listPending(session.actor.orgId, deps.clock.nowMs());
        return {
            kind: 'ok',
            body: {
                linkCodes: pending.map((code) => ({
                    linkCodeId: code.id,
                    createdAt: code.createdAt,
                    expiresAt: code.expiresAt,
                })),
            },
        };
    });

    // Before `getEngine`, whose `:engineId` would otherwise claim the path.
    bind(router, mount, apiRoutes.linkEligibility, async ({ request, session }) => {
        const decision = await deps.policy.checkEligibility(session.actor.orgId, request.signal);
        const eligibility: LinkEligibilityView['eligibility'] =
            decision.kind === 'allowed' ? 'allowed' : decision.reason;
        return {
            kind: 'ok',
            body: {
                eligibility,
                linkCodeTtlS: Math.round(deps.config.linkCodeTtlMs / 1000),
                installGuideUrl: deps.config.installGuideUrl,
            },
        };
    });

    bind(router, mount, apiRoutes.getLinkCode, async ({ input, session }) => {
        const status = await readLinkCodeStatus(
            deps,
            session.actor.orgId,
            linkCodeIdSchema.parse(input.params.linkCodeId),
        );
        switch (status.kind) {
            case 'not-found':
                return { kind: 'problem', status: 404, code: 'not-found' };
            case 'pending':
                return { kind: 'ok', body: { status: 'pending' as const, expiresAt: status.expiresAt } };
            case 'expired':
                return { kind: 'ok', body: { status: 'expired' as const } };
            case 'linked':
                return {
                    kind: 'ok',
                    body: { status: 'linked' as const, engineId: status.engineId, hostname: status.hostname },
                };
        }
    });

    bind(router, mount, apiRoutes.cancelLinkCode, async ({ input, session }) => {
        const outcome = await deps.linkCodes.cancel(
            session.actor.orgId,
            linkCodeIdSchema.parse(input.params.linkCodeId),
            deps.clock.nowMs(),
        );
        return outcome === 'cancelled'
            ? { kind: 'ok', body: undefined, status: 204 }
            : { kind: 'problem', status: 404, code: 'not-found' };
    });

    bind(router, mount, apiRoutes.listEngines, async ({ session }) => {
        const visible = await visibleEngineIds(deps, session.actor);
        const engines = (await deps.engines.listForOrg(session.actor.orgId)).filter(
            (engine) => visible === null || visible.has(engine.engineId),
        );
        const overviews = await readEngineOverviews(deps, engines);
        return { kind: 'ok', body: { engines: overviews.map(engineView) } };
    });

    bind(router, mount, apiRoutes.getInstallGuide, () =>
        Promise.resolve({ kind: 'ok', body: { url: deps.config.installGuideUrl } }),
    );

    bind(router, mount, apiRoutes.getEngine, async ({ input, session }) => {
        const visible = await visibleEngineIds(deps, session.actor);
        const engine = await deps.engines.findInOrg(session.actor.orgId, input.params.engineId);
        if (engine === null || (visible !== null && !visible.has(engine.engineId))) {
            return { kind: 'problem', status: 404, code: 'not-found' };
        }
        return { kind: 'ok', body: { engine: engineView(await readEngineOverview(deps, engine)) } };
    });

    bind(router, mount, apiRoutes.renameEngine, async ({ input, session }) => {
        const { engineId } = input.params;
        const outcome = await renameEngine(deps, session.actor, engineId, input.body.label);
        const engine = outcome === 'not-found' ? null : await deps.engines.findInOrg(session.actor.orgId, engineId);
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
