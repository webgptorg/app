import {
    REGISTER_PATH,
    REGISTER_REQUEST_MAX_BYTES,
    REGISTRATION_ERROR_CODE,
    RegisterEngineRequest,
    RegisterEngineResponse,
} from '@ptbk/protocol';
import { Hono } from 'hono';
import { z } from 'zod';

import type { EngineCreationPolicy } from '../../domain/registration/engine-creation-policy';
import { registerEngine } from '../../domain/registration/register-engine';
import { defineRoute, NO_INPUT } from '../../shared/api/contract';
import { environmentSchema } from '../../shared/environment';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

export const V1_MOUNT = '/v1';

export const healthRoute = defineRoute({
    method: 'GET',
    path: '/v1/health',
    auth: 'public',
    permission: null,
    rateLimit: 'public-read-ip',
    input: NO_INPUT,
    output: z.strictObject({ ok: z.literal(true), environment: environmentSchema }),
    errorCodes: [],
});

/**
 * C-03's registration contract. The binder applies the per-IP limit, the size cap and the strict parse in that order;
 * the handler verifies the engine's signature before it reads anything.
 */
export const registerRoute = defineRoute({
    method: 'POST',
    path: REGISTER_PATH,
    auth: 'engine-signature',
    permission: null,
    rateLimit: 'registration-ip',
    input: { ...NO_INPUT, body: RegisterEngineRequest, maxBodyBytes: REGISTER_REQUEST_MAX_BYTES },
    output: RegisterEngineResponse,
    errorCodes: [...Object.values(REGISTRATION_ERROR_CODE), 'not-entitled'],
});

/** Machine API for engines. Cookies are ignored here; heartbeat (D-05) binds its protocol contract next. */
export function createV1Router(
    deps: Pick<DashboardDeps, 'config' | 'clock' | 'logger' | 'linkCodes' | 'engines'> & {
        readonly policy: EngineCreationPolicy;
        readonly routes: RouteBinder;
    },
): Hono {
    const router = new Hono();
    deps.routes.bind(router, V1_MOUNT, healthRoute, () =>
        Promise.resolve({ kind: 'ok', body: { ok: true, environment: deps.config.environment } }),
    );
    const registration = {
        ...deps,
        engineDomain: deps.config.engineDomain,
        relays: deps.config.relays.map((relay) => relay.relayId),
    };
    deps.routes.bind(router, V1_MOUNT, registerRoute, async ({ input, request }) => {
        const outcome = await registerEngine(registration, input.body, request.signal);
        switch (outcome.kind) {
            case 'registered':
                return { kind: 'ok', body: outcome.response };
            case 'invalid-link-code':
            case 'bad-signature':
                return { kind: 'problem', status: 401, code: outcome.kind };
            case 'engine-suspended':
            case 'not-entitled':
            case 'engine-limit':
                return { kind: 'problem', status: 403, code: outcome.kind };
            case 'engine-exists':
                return { kind: 'problem', status: 409, code: outcome.kind };
        }
    });
    return router;
}
