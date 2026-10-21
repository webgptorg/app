import type { Hono } from 'hono';

import type { EngineCreationPolicy } from '../../domain/registration/engine-creation-policy';
import { issueLinkCode } from '../../domain/registration/issue-link-code';
import { apiRoutes } from '../../shared/api/routes';
import { LINK_CODE_PLACEHOLDER } from '../config';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

/** D-03's `/api` routes. The organization is always the session's active one, never a request field. */
export function bindEngineRoutes(
    router: Hono,
    mount: string,
    deps: Pick<DashboardDeps, 'config' | 'clock' | 'random' | 'linkCodes'> & {
        readonly policy: EngineCreationPolicy;
        readonly routes: RouteBinder;
    },
): void {
    deps.routes.bind(router, mount, apiRoutes.createLinkCode, async ({ request, session }) => {
        const outcome = await issueLinkCode(
            deps,
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
}
