import type { Hono } from 'hono';
import { z } from 'zod';

import { renderInstallScript } from '../../domain/registration/install-scripts';
import { INSTALL_SCRIPT_PATHS, type InstallScript } from '../../domain/registration/installation-options';
import { defineRoute, NO_INPUT } from '../../shared/api/contract';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

function scriptRoute<const P extends `/${string}`>(path: P) {
    return defineRoute({
        method: 'GET',
        path,
        auth: 'public',
        permission: null,
        rateLimit: 'public-read-ip',
        input: NO_INPUT,
        output: z.string().max(32 * 1024),
        responseType: 'text',
        errorCodes: [],
    });
}

export const installScriptRoutes = {
    desktop: scriptRoute(INSTALL_SCRIPT_PATHS.desktop),
    server: scriptRoute(INSTALL_SCRIPT_PATHS.server),
    windows: scriptRoute(INSTALL_SCRIPT_PATHS.windows),
} as const satisfies Record<InstallScript, unknown>;

/**
 * Public and identical for everyone: a script carries the release selected now, the same way link-code issuance does,
 * and no pairing data. Without installation metadata or an https origin there is no link URL to pair with.
 */
export function bindInstallScriptRoutes(
    app: Hono,
    deps: Pick<DashboardDeps, 'config' | 'installReleases'> & { readonly routes: RouteBinder },
): void {
    const { engineInstallation, dashboardOrigin } = deps.config;
    for (const script of Object.keys(installScriptRoutes) as InstallScript[]) {
        deps.routes.bind(app, '', installScriptRoutes[script], async ({ request }) => {
            if (engineInstallation === undefined || !dashboardOrigin.startsWith('https://')) {
                return { kind: 'problem', status: 404, code: 'not-found' };
            }
            const release = await deps.installReleases.current(engineInstallation, request.signal);
            return { kind: 'ok', body: renderInstallScript(script, release, dashboardOrigin) };
        });
    }
}
