import type { EngineApiRouteId, RouteDefinition } from '@ptbk/engine-api';
import { ENGINE_API_PREFIX, ENGINE_API_ROUTE_LIST, MAX_FILE_BYTES } from '@ptbk/engine-api';
import { serveEngineApiRoute } from '@ptbk/engine-api/http';
import type { InMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import { z } from 'zod';

import type { RateLimitRule } from '../../domain/rate-limit/rate-limiter';
import type { HttpRoute, RouteBody } from './route';
import { defineHttpRoute } from './route';

/** Book sources go up to 512 Ki UTF-16 units, which UTF-8 can triple; nothing else in JSON comes close. */
const JSON_MAX_BYTES = 2 * 1024 * 1024;
/** Room for the multipart framing and the other fields around one file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const NO_QUERY = z.strictObject({});
const SSE_HEADERS = z.strictObject({ 'last-event-id': z.string().max(64).optional() });

function bodyOf(route: RouteDefinition): RouteBody | null {
    switch (route.body?.kind) {
        case undefined:
            return null;
        case 'json':
            return { kind: 'json', schema: route.body.schema, maxBytes: JSON_MAX_BYTES };
        case 'binary':
            return { kind: 'binary', schema: route.body.schema, maxBytes: route.body.maxBytes };
        case 'multipart':
            return {
                kind: 'multipart',
                schema: route.body.schema,
                maxBytes: MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES,
            };
    }
}

/** Routes that cost more than a lookup get their own, tighter budget; everything else shares `engine-api-ip`. */
const RATE_LIMIT_BY_ROUTE: Partial<Record<EngineApiRouteId, RateLimitRule>> = {
    testAgentDraft: 'engine-api-test-chat-ip',
    transcribeVoiceClip: 'engine-api-voice-ip',
    speakChatMessage: 'engine-api-voice-ip',
    checkAiTool: 'engine-api-ai-tools-ip',
    answerAiToolSignIn: 'engine-api-ai-tools-ip',
};

function isStream(route: RouteDefinition): boolean {
    return Object.values(route.responses).some((response) => response.kind === 'sse');
}

/**
 * Every operation of C-04's route table, declared from the table itself: method, path, permission and schemas are
 * never written by hand here, and the mock holds no entity state of its own. The core behind `core()` validates and
 * authorises again with the request's actor, audits, and answers exactly as the contract says.
 */
export function createEngineApiRoutes(deps: { readonly core: () => InMemoryEngineCore }): readonly HttpRoute[] {
    return ENGINE_API_ROUTE_LIST.map((route) =>
        defineHttpRoute({
            transport: 'http',
            method: route.method,
            path: `${ENGINE_API_PREFIX}${route.path}`,
            auth: 'session',
            validation: 'engine-api',
            permission: route.permission,
            rateLimit: RATE_LIMIT_BY_ROUTE[route.id as EngineApiRouteId] ?? 'engine-api-ip',
            params: route.params ?? null,
            query: route.query ?? NO_QUERY,
            headers: isStream(route) ? SSE_HEADERS : null,
            body: bodyOf(route),
            handle: ({ actor, request, params }) =>
                serveEngineApiRoute(
                    deps.core().transport(actor),
                    route,
                    params as unknown as Readonly<Record<string, string>>,
                    request,
                ),
        }),
    );
}
