import { z } from 'zod';

import { CapabilityRef } from './capabilities/capability';
import { EngineId, Hostname } from './common';
import { defineRoute } from './route';

export const ENGINE_MODES = ['tunnel', 'direct', 'local'] as const;

export const EngineInfo = z.strictObject({
    name: z.string().min(1).max(128),
    /**
     * The engine's ID, from which the UI derives the engine fingerprint. Engines on API 1.1 always send it; one on API
     * 1.0 does not, which reads as `null` (the UI then shows no fingerprint).
     */
    engineId: EngineId.nullable().default(null),
    /** The hostname the UI was loaded from: the default `<engineId>.<engine domain>` or a custom domain. */
    hostname: Hostname,
    /** `null` while the engine is not linked to a dashboard, e.g. in local mode. */
    dashboardUrl: z
        .url({ protocol: /^https$/ })
        .max(2048)
        .nullable(),
    mode: z.enum(ENGINE_MODES),
    /**
     * Optional capabilities (ADR 0016). Engines on API 1.0 do not send the field, which reads as none. Entries the
     * client does not know are kept but never match `supports`.
     */
    capabilities: z.array(CapabilityRef).max(64).default([]),
});
export type EngineInfo = z.infer<typeof EngineInfo>;

export const ENGINE_ROUTES = {
    getEngine: defineRoute({
        id: 'getEngine',
        method: 'GET',
        path: '/engine',
        summary: 'Get engine identity, mode and capabilities',
        permission: null,
        responses: { 200: { kind: 'json', schema: EngineInfo } },
    }),
} as const;
