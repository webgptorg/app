import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { EngineApiContractError } from './client';
import type { EngineApiTransport } from './client';
import { defineRoute } from './route';
import type { EngineApiStreamItem, RouteDefinition } from './route';
import { readJsonResponse, readStreamEvent, readTolerantly, withClientReading } from './reader';
import { ENGINE_API_ROUTES } from './routes';

const tick = z.strictObject({ type: z.literal('tick'), n: z.int() });
const sseRoute = defineRoute({
    id: 'testStream',
    method: 'GET',
    path: '/test',
    summary: 'Test stream',
    permission: null,
    responses: { 200: { kind: 'sse', event: z.discriminatedUnion('type', [tick]) } },
});
const sse = sseRoute.responses[200];
const signal = () => AbortSignal.timeout(1_000);

async function* items(...events: unknown[]): AsyncIterable<EngineApiStreamItem<unknown>> {
    for (const [index, event] of events.entries()) {
        await Promise.resolve();
        yield { id: String(index + 1), event };
    }
}

async function collect(stream: AsyncIterable<EngineApiStreamItem<unknown>>) {
    const all: EngineApiStreamItem<unknown>[] = [];
    for await (const item of stream) all.push(item);
    return all;
}

describe('client reading', () => {
    it('names the failing path, or (root) for the whole value, but never the value', () => {
        const route = ENGINE_API_ROUTES.getEngine;
        const json = route.responses[200];
        expect(() => readJsonResponse(route, json, 'SENSITIVE')).toThrow(/\(root\) invalid_type/);
        expect(() => readJsonResponse(route, json, { name: 7 })).toThrow(EngineApiContractError);
        try {
            readTolerantly(route, z.strictObject({ name: z.string() }), { name: 'SENSITIVE-7' }, 'thing');
            readTolerantly(route, z.strictObject({ name: z.int() }), { name: 'SENSITIVE-7' }, 'thing');
        } catch (error) {
            expect(String(error)).toContain('thing does not match the schema (name invalid_type)');
            expect(String(error)).not.toContain('SENSITIVE');
        }
    });

    it('skips unknown event types and refuses events without a type', () => {
        expect(readStreamEvent(sseRoute, sse, { type: 'tock' })).toBeUndefined();
        expect(readStreamEvent(sseRoute, sse, { type: 'tick', n: 1, extra: true })).toEqual({ type: 'tick', n: 1 });
        expect(() => readStreamEvent(sseRoute, sse, { n: 1 })).toThrow(/without a type/);
        expect(() => readStreamEvent(sseRoute, sse, null)).toThrow(/without a type/);
    });

    it('knows no event types for an event schema that is not a discriminated union', () => {
        const plain: RouteDefinition = {
            ...sseRoute,
            responses: { 200: { kind: 'sse', event: z.strictObject({ type: z.string() }) } },
        };
        const response = plain.responses[200];
        if (response?.kind !== 'sse') throw new Error('not sse');
        expect(readStreamEvent(plain, response, { type: 'anything' })).toBeUndefined();
        const loose: RouteDefinition = {
            ...sseRoute,
            responses: {
                200: {
                    kind: 'sse',
                    event: z.union([tick, z.strictObject({ type: z.string(), x: z.int() })]),
                },
            },
        };
        const looseResponse = loose.responses[200];
        if (looseResponse?.kind !== 'sse') throw new Error('not sse');
        expect(readStreamEvent(loose, looseResponse, { type: 'tick', n: 2 })).toEqual({ type: 'tick', n: 2 });
    });

    it('reads what an engine transport sends: streams, events the reader drops, and empty bodies', async () => {
        const engine: EngineApiTransport = (route) => {
            if (route.id === 'testStream') {
                return Promise.resolve({
                    kind: 'ok',
                    data: items({ type: 'tick', n: 1 }, { type: 'tock' }, { type: 'tick', n: 2 }),
                });
            }
            if (route.id === 'streamEvents') {
                return Promise.resolve({
                    kind: 'ok',
                    data: items(
                        { type: 'activity', activity: { kind: 'broken' } },
                        { type: 'agent.changed', agentId: 'a1' },
                    ),
                });
            }
            return Promise.resolve({ kind: 'ok', data: null });
        };
        const client = withClientReading(engine);
        const ticks = await client(sseRoute, {}, signal());
        expect(
            ticks.kind === 'ok' && (await collect(ticks.data as AsyncIterable<EngineApiStreamItem<unknown>>)),
        ).toEqual([
            { id: '1', event: { type: 'tick', n: 1 } },
            { id: '3', event: { type: 'tick', n: 2 } },
        ]);
        const events = await client(ENGINE_API_ROUTES.streamEvents, {}, signal());
        expect(
            events.kind === 'ok' && (await collect(events.data as AsyncIterable<EngineApiStreamItem<unknown>>)),
        ).toEqual([{ id: '2', event: { type: 'agent.changed', agentId: 'a1' } }]);
        expect(await client(ENGINE_API_ROUTES.deleteFile, { params: { fileId: 'f1' } }, signal())).toEqual({
            kind: 'ok',
            data: null,
        });
        const noResponses: RouteDefinition = { ...sseRoute, id: 'noResponses', responses: {} };
        expect(await client(noResponses, {}, signal())).toEqual({ kind: 'ok', data: null });
    });

    it('passes problems through untouched', async () => {
        const problem = { kind: 'problem', problem: { code: 'forbidden' } } as never;
        const client = withClientReading(() => Promise.resolve(problem));
        expect(await client(ENGINE_API_ROUTES.getEngine, {}, signal())).toBe(problem);
    });
});
