import type { z } from 'zod';

import { EngineApiContractError } from './client';
import type { EngineApiResponse, EngineApiTransport } from './client';
import type { EngineApiStreamItem, RouteDefinition, RouteResponse, SseEventSchema } from './route';
import { toTolerant } from './tolerant';

type Reader = z.ZodType;

const tolerantReaders = new WeakMap<z.ZodType, Reader>();

function tolerantOf(schema: z.ZodType): Reader {
    let reader = tolerantReaders.get(schema);
    if (!reader) {
        reader = toTolerant(schema);
        tolerantReaders.set(schema, reader);
    }
    return reader;
}

function check(route: RouteDefinition, reader: Reader, value: unknown, what: string): unknown {
    const result = reader.safeParse(value);
    if (result.success) return result.data;
    // Paths and issue codes only: the values may be content.
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.code}`);
    throw new EngineApiContractError(route.id, `${what} does not match the schema (${issues.join(', ')})`);
}

/** The client's reading of a JSON success body: the route's `read`, or its schema with unknown fields stripped. */
export function readJsonResponse(
    route: RouteDefinition,
    response: Extract<RouteResponse, { kind: 'json' }>,
    value: unknown,
): unknown {
    return check(route, response.read ?? tolerantOf(response.schema), value, 'response body');
}

/** Problems and other schemas outside the route table are read tolerantly too. */
export function readTolerantly<Schema extends z.ZodType>(
    route: RouteDefinition,
    schema: Schema,
    value: unknown,
    what: string,
): z.output<Schema> {
    return check(route, tolerantOf(schema), value, what) as z.output<Schema>;
}

/** Event types the route's event schema declares, read from its discriminated union. */
function knownEventTypes(schema: SseEventSchema): ReadonlySet<string> {
    const options = (schema as unknown as { readonly options?: readonly z.ZodObject[] }).options ?? [];
    const types = new Set<string>();
    for (const option of options) {
        const literal = option.shape['type'] as { readonly value?: unknown } | undefined;
        if (typeof literal?.value === 'string') types.add(literal.value);
    }
    return types;
}

const eventTypeCache = new WeakMap<SseEventSchema, ReadonlySet<string>>();

/**
 * One stream event as the client reads it, or `undefined` for an event to skip: a type the client does not know, or
 * one the route's `read` turns down. Engines may add event types within a version.
 */
export function readStreamEvent(
    route: RouteDefinition,
    response: Extract<RouteResponse, { kind: 'sse' }>,
    value: unknown,
): { readonly type: string } | undefined {
    const type = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['type'] : undefined;
    if (typeof type !== 'string') throw new EngineApiContractError(route.id, 'stream event without a type');
    let known = eventTypeCache.get(response.event);
    if (!known) {
        known = knownEventTypes(response.event);
        eventTypeCache.set(response.event, known);
    }
    if (!known.has(type)) return undefined;
    const event = check(route, response.read ?? tolerantOf(response.event), value, 'stream event');
    return event === null ? undefined : (event as { readonly type: string });
}

/**
 * Applies the client's reading to a transport that resolves with what the engine sent (the in-memory engine), so the
 * in-memory client resolves with exactly what the fetch client would.
 */
export function withClientReading(engine: EngineApiTransport): EngineApiTransport {
    return async (route, request, signal) => {
        const result: EngineApiResponse<unknown> = await engine(route, request, signal);
        if (result.kind === 'problem') return result;
        const [success] = Object.values(route.responses);
        switch (success?.kind) {
            case 'json':
                return { kind: 'ok', data: readJsonResponse(route, success, result.data) };
            case 'sse':
                return {
                    kind: 'ok',
                    data: readStream(route, success, result.data as AsyncIterable<EngineApiStreamItem<unknown>>),
                };
            case 'empty':
            case 'binary':
            case undefined:
                return result;
        }
    };
}

async function* readStream(
    route: RouteDefinition,
    response: Extract<RouteResponse, { kind: 'sse' }>,
    items: AsyncIterable<EngineApiStreamItem<unknown>>,
): AsyncIterable<EngineApiStreamItem<unknown>> {
    for await (const item of items) {
        const event = readStreamEvent(route, response, item.event);
        if (event !== undefined) yield { id: item.id, event };
    }
}
