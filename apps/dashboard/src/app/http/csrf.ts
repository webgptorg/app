import type { MiddlewareHandler } from 'hono';

import { problemResponse } from './problem';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses cross-site state changes before any handler runs. Browsers that send Fetch Metadata are trusted on
 * `Sec-Fetch-Site`; for the rest, `Origin` must be the dashboard's own. A request with neither is refused too.
 */
export function crossSiteRequestGuard(dashboardOrigin: string): MiddlewareHandler {
    return async (context, next) => {
        if (!SAFE_METHODS.has(context.req.method)) {
            const site = context.req.header('Sec-Fetch-Site');
            const allowed =
                site === undefined ? context.req.header('Origin') === dashboardOrigin : site === 'same-origin';
            if (!allowed) {
                return problemResponse(403, 'forbidden');
            }
        }
        await next();
        return undefined;
    };
}
