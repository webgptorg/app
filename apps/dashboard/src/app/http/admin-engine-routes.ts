import type { Hono } from 'hono';

import type { PlatformEngineStore } from '../../domain/engines/platform-engine-store';
import { suspendEngine, unsuspendEngine } from '../../domain/engines/suspend-engine';
import { OWNER_REVOKED, type EngineRecord } from '../../domain/registration/engine-store';
import { apiRoutes, type AdminEngineView } from '../../shared/api/routes';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

export function adminEngineView(engine: EngineRecord): AdminEngineView {
    return {
        engineId: engine.engineId,
        orgId: engine.orgId,
        hostname: engine.hostname,
        mode: engine.mode,
        registeredVersion: engine.engineVersion,
        status: engine.status,
        suspendedBy: engine.status === 'active' ? null : engine.statusReason === OWNER_REVOKED ? 'owner' : 'platform',
        createdAt: engine.createdAt,
        updatedAt: engine.updatedAt,
    };
}

/** I-05's platform admin routes: look an engine up, suspend it, lift a platform suspension. */
export function bindAdminEngineRoutes(
    router: Hono,
    mount: string,
    deps: Pick<DashboardDeps, 'clock' | 'random' | 'logger' | 'platformEngines'> & { readonly routes: RouteBinder },
): void {
    const current = async (store: Pick<PlatformEngineStore, 'find'>, engineId: EngineRecord['engineId']) => {
        const engine = await store.find(engineId);
        return engine === null
            ? ({ kind: 'problem', status: 404, code: 'not-found' } as const)
            : ({ kind: 'ok', body: { engine: adminEngineView(engine) } } as const);
    };

    deps.routes.bind(router, mount, apiRoutes.adminGetEngine, ({ input }) =>
        current(deps.platformEngines, input.params.engineId),
    );

    deps.routes.bind(router, mount, apiRoutes.adminSuspendEngine, async ({ input, session }) => {
        const { engineId } = input.params;
        const outcome = await suspendEngine(deps, {
            engineId,
            adminUserId: session.actor.userId,
            reason: input.body.reason,
        });
        return outcome === 'not-found'
            ? { kind: 'problem', status: 404, code: 'not-found' }
            : current(deps.platformEngines, engineId);
    });

    deps.routes.bind(router, mount, apiRoutes.adminUnsuspendEngine, async ({ input, session }) => {
        const { engineId } = input.params;
        const outcome = await unsuspendEngine(deps, {
            engineId,
            adminUserId: session.actor.userId,
            reason: input.body.reason,
        });
        switch (outcome) {
            case 'not-found':
                return { kind: 'problem', status: 404, code: 'not-found' };
            case 'owner-revoked':
                return { kind: 'problem', status: 409, code: 'owner-revoked' };
            case 'unsuspended':
            case 'not-suspended':
                return current(deps.platformEngines, engineId);
        }
    });
}
