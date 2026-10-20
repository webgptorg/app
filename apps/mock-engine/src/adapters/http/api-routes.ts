import type { RouteDefinition } from '@ptbk/engine-api';
import { ENGINE_API_PREFIX, ENGINE_API_ROUTE_LIST, MAX_FILE_BYTES } from '@ptbk/engine-api';
import { serveEngineApiRoute } from '@ptbk/engine-api/http';
import type { InMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import { z } from 'zod';

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
        case 'multipart':
            return {
                kind: 'multipart',
                schema: route.body.schema,
                maxBytes: MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES,
            };
    }
}

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
            permission: route.permission,
            rateLimit: 'engine-api-ip',
            params: route.params ?? null,
            query: route.query ?? NO_QUERY,
            headers: isStream(route) ? SSE_HEADERS : null,
            body: bodyOf(route),
            handle: ({ actor, request, params }) =>
                serveEngineApiRoute(
                    deps.core().transport(actor),
                    route,
                    // Parsed IDs are the decoded path segments; the core parses them into branded IDs itself.
                    Object.fromEntries(
                        Object.entries(params ?? {}).map(([name, value]) => [
                            name,
                            typeof value === 'string' ? value : '',
                        ]),
                    ),
                    request,
                ),
        }),
    );
}
