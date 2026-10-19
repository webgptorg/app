import { z } from 'zod';

import { Hostname } from './common';
import { defineRoute } from './route';

export const ENGINE_MODES = ['tunnel', 'direct', 'local'] as const;

export const EngineInfo = z.strictObject({
    name: z.string().min(1).max(128),
    hostname: Hostname,
    /** `null` while the engine is not linked to a dashboard, e.g. in local mode. */
    dashboardUrl: z
        .url({ protocol: /^https$/ })
        .max(2048)
        .nullable(),
    mode: z.enum(ENGINE_MODES),
});
export type EngineInfo = z.infer<typeof EngineInfo>;

export const ENGINE_ROUTES = {
    getEngine: defineRoute({
        id: 'getEngine',
        method: 'GET',
        path: '/engine',
        summary: 'Get engine identity and mode',
        permission: null,
        responses: { 200: { kind: 'json', schema: EngineInfo } },
    }),
} as const;
