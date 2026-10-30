import {
    EngineId,
    HEARTBEAT_MAX_BODY_BYTES,
    HEARTBEAT_SIGNATURE_HEADER,
    HeartbeatReply,
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
import { ingestHeartbeat } from '../../domain/status/ingest-heartbeat';
import type { EmailMessage } from '../../domain/ports/email-sender';
import { handleHeartbeatV2 } from '../../domain/teams/member-access';
import { memberAccessDeps } from './team-routes';
import { defineRoute, NO_CONTENT, NO_INPUT, RAW_BODY } from '../../shared/api/contract';
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
    errorCodes: Object.values(REGISTRATION_ERROR_CODE),
});

/** The problem codes of C-03's `verifyHeartbeat` outcomes; `stale-timestamp` carries `serverTime`. */
export const HEARTBEAT_ERROR_CODE = Object.freeze({
    badSignatureHeader: 'bad-signature-header',
    badSignature: 'bad-signature',
    invalidBody: 'invalid-body',
    engineMismatch: 'engine-mismatch',
    replayedSeq: 'replayed-seq',
    staleTimestamp: 'stale-timestamp',
} as const);

const SIGNATURE_HEADER = HEARTBEAT_SIGNATURE_HEADER.toLowerCase();

/**
 * C-03's heartbeat (Interface 4). Limited per IP, then per engine, then capped at 4 KiB; the body reaches the engine's
 * Durable Object as received, where `verifyHeartbeat` checks the signature before anything parses it. A malformed or
 * oversized signature header counts as a missing one, so every header problem is C-03's `bad-signature-header`.
 */
export const heartbeatRoute = defineRoute({
    method: 'POST',
    path: '/v1/engines/:engineId/heartbeat',
    auth: 'engine-signature',
    permission: null,
    rateLimit: 'heartbeat-ip',
    engineRateLimit: 'heartbeat-engine',
    input: {
        params: z.strictObject({ engineId: EngineId }),
        query: null,
        headers: z.strictObject({ [SIGNATURE_HEADER]: z.string().max(256).optional().catch(undefined) }),
        body: RAW_BODY,
        maxBodyBytes: HEARTBEAT_MAX_BODY_BYTES,
    },
    // 204 to a v1 heartbeat; a v2 one gets the revocations the engine still owes an ack (ADR 0018).
    output: z.union([NO_CONTENT, HeartbeatReply]),
    errorCodes: [...Object.values(HEARTBEAT_ERROR_CODE), REGISTRATION_ERROR_CODE.engineSuspended],
});

/** Machine API for engines. Cookies are ignored here. */
export function createV1Router(
    deps: Pick<
        DashboardDeps,
        | 'config'
        | 'clock'
        | 'random'
        | 'logger'
        | 'metrics'
        | 'linkCodes'
        | 'engines'
        | 'teams'
        | 'memberKey'
        | 'links'
        | 'email'
        | 'heartbeatEngines'
        | 'engineStatus'
    > & {
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
        deps.metrics.record({ name: 'ptbk_dashboard_registrations_total', outcome: outcome.kind });
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
    deps.routes.bind(router, V1_MOUNT, heartbeatRoute, async ({ input, request }) => {
        const outcome = await ingestHeartbeat(deps, {
            engineId: input.params.engineId,
            rawBody: input.body,
            signatureHeader: input.headers[SIGNATURE_HEADER] ?? null,
        });
        deps.metrics.record({ name: 'ptbk_dashboard_heartbeats_total', outcome: outcome.kind });
        switch (outcome.kind) {
            case 'accepted': {
                if (outcome.heartbeat.v === 1) {
                    return { kind: 'ok', body: undefined, status: 204 };
                }
                const { reply, deliver } = await handleHeartbeatV2(
                    memberAccessDeps(deps),
                    input.params.engineId,
                    outcome.heartbeat,
                );
                request.waitUntil(sendAccessEmails(deps, deliver));
                return { kind: 'ok', body: reply };
            }
            case 'unknown-engine':
                return { kind: 'problem', status: 404, code: 'not-found' };
            case 'engine-suspended':
                return { kind: 'problem', status: 403, code: REGISTRATION_ERROR_CODE.engineSuspended };
            case 'bad-signature-header':
                return { kind: 'problem', status: 401, code: HEARTBEAT_ERROR_CODE.badSignatureHeader };
            case 'bad-signature':
                return { kind: 'problem', status: 401, code: HEARTBEAT_ERROR_CODE.badSignature };
            case 'invalid-body':
                return { kind: 'problem', status: 400, code: HEARTBEAT_ERROR_CODE.invalidBody };
            case 'engine-mismatch':
                return { kind: 'problem', status: 400, code: HEARTBEAT_ERROR_CODE.engineMismatch };
            case 'replayed-seq':
                return { kind: 'problem', status: 409, code: HEARTBEAT_ERROR_CODE.replayedSeq };
            case 'stale-ts':
                return {
                    kind: 'problem',
                    status: 401,
                    code: HEARTBEAT_ERROR_CODE.staleTimestamp,
                    extensions: { serverTime: outcome.serverTime },
                };
        }
    });
    return router;
}

const EMAIL_TIMEOUT_MS = 30_000;

async function sendAccessEmails(
    deps: Pick<DashboardDeps, 'email' | 'logger'>,
    deliver: (send: (message: EmailMessage) => Promise<void>) => Promise<void>,
): Promise<void> {
    const signal = AbortSignal.timeout(EMAIL_TIMEOUT_MS);
    try {
        await deliver((message) => deps.email.send(message, signal));
    } catch (error) {
        deps.logger.error('heartbeat.access-email-failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
}
