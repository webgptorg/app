import { Hono } from 'hono';
import { z } from 'zod';

import { securityTxt } from '../../domain/abuse/security-txt';
import { defineRoute, NO_INPUT } from '../../shared/api/contract';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

export const WELL_KNOWN_MOUNT = '/.well-known';

/** RFC 9116; the abuse address is the contact (I-05), and `/abuse` the policy. Nothing in it is secret. */
export const securityTxtRoute = defineRoute({
    method: 'GET',
    path: '/.well-known/security.txt',
    auth: 'public',
    permission: null,
    rateLimit: 'public-read-ip',
    input: NO_INPUT,
    output: z.string().max(4096),
    responseType: 'text',
    errorCodes: [],
});

export function createWellKnownRouter(
    deps: Pick<DashboardDeps, 'config' | 'clock'> & { readonly routes: RouteBinder },
): Hono {
    const router = new Hono();
    deps.routes.bind(router, WELL_KNOWN_MOUNT, securityTxtRoute, () =>
        Promise.resolve({
            kind: 'ok',
            body: securityTxt({
                abuseEmail: deps.config.abuseEmail,
                dashboardOrigin: deps.config.dashboardOrigin,
                nowMs: deps.clock.nowMs(),
            }),
        }),
    );
    return router;
}
