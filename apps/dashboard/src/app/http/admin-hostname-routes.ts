import { expectedCnameTarget } from '@ptbk/protocol';
import type { Hono } from 'hono';

import { addCustomHostname } from '../../domain/custom-hostnames/add-custom-hostname';
import { checkCustomHostname } from '../../domain/custom-hostnames/check-custom-hostname';
import type { CustomHostnameRecord } from '../../domain/custom-hostnames/custom-hostname-store';
import { PLATFORM_DOMAIN } from '../../domain/custom-hostnames/normalise-hostname';
import { removeCustomHostname } from '../../domain/custom-hostnames/remove-custom-hostname';
import { apiRoutes, type CustomHostnameView } from '../../shared/api/routes';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

function view(record: CustomHostnameRecord): CustomHostnameView {
    return {
        hostname: record.hostname,
        status: record.status,
        dnsCheckedAt: record.dnsCheckedAt,
        createdAt: record.createdAt,
    };
}

/** D-08's platform admin routes for Enterprise custom hostnames. Platform admins act on any organization's engine. */
export function bindAdminHostnameRoutes(
    router: Hono,
    mount: string,
    deps: Pick<DashboardDeps, 'config' | 'clock' | 'random' | 'customHostnames' | 'dns'> & {
        readonly routes: RouteBinder;
    },
): void {
    const { engineDomain } = deps.config;
    const reservedDomains = [PLATFORM_DOMAIN, engineDomain, ...deps.config.relays.map((relay) => relay.relayId)];

    deps.routes.bind(router, mount, apiRoutes.adminListHostnames, async ({ input }) => {
        const { engineId } = input.params;
        const engine = await deps.customHostnames.findEngine(engineId);
        if (engine === null) {
            return { kind: 'problem', status: 404, code: 'not-found' };
        }
        const records = await deps.customHostnames.listForEngine(engineId);
        return {
            kind: 'ok',
            body: {
                engineId,
                orgId: engine.orgId,
                expectedTarget: expectedCnameTarget(engineId, engineDomain),
                hostnames: records.map(view),
            },
        };
    });

    deps.routes.bind(router, mount, apiRoutes.adminAddHostname, async ({ input, session }) => {
        const outcome = await addCustomHostname(
            { ...deps, engineDomain, reservedDomains },
            {
                engineId: input.params.engineId,
                hostname: input.body.hostname,
                claimSig: input.body.claimSig,
                adminUserId: session.actor.userId,
            },
        );
        switch (outcome.kind) {
            case 'added':
                return { kind: 'ok', body: { hostname: view(outcome.record) } };
            case 'engine-not-found':
                return { kind: 'problem', status: 404, code: 'not-found' };
            case 'invalid-hostname':
            case 'reserved-domain':
            case 'bad-claim':
                return { kind: 'problem', status: 400, code: outcome.kind };
            case 'taken':
            case 'limit-reached':
                return { kind: 'problem', status: 409, code: outcome.kind };
        }
    });

    deps.routes.bind(router, mount, apiRoutes.adminCheckHostname, async ({ input, request, session }) => {
        const outcome = await checkCustomHostname(
            { ...deps, engineDomain },
            { ...input.params, adminUserId: session.actor.userId },
            request.signal,
        );
        switch (outcome.kind) {
            case 'checked':
                return { kind: 'ok', body: { hostname: view(outcome.record), lookup: outcome.lookup } };
            case 'not-found':
                return { kind: 'problem', status: 404, code: 'not-found' };
        }
    });

    deps.routes.bind(router, mount, apiRoutes.adminRemoveHostname, async ({ input, session }) => {
        const outcome = await removeCustomHostname(deps, { ...input.params, adminUserId: session.actor.userId });
        switch (outcome.kind) {
            case 'removed':
                return { kind: 'ok', body: {} };
            case 'not-found':
                return { kind: 'problem', status: 404, code: 'not-found' };
        }
    });
}
