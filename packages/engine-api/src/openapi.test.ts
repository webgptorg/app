import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';

import committed from '../openapi.json' with { type: 'json' };
import { capabilityLabel } from './capabilities/capability';
import { buildOpenApiDocument } from './openapi';
import { ENGINE_API_ROUTE_LIST } from './routes';

const document = buildOpenApiDocument();

function collectRefs(node: unknown, refs: Set<string>): Set<string> {
    if (Array.isArray(node)) {
        for (const item of node) collectRefs(item, refs);
    } else if (typeof node === 'object' && node !== null) {
        for (const [key, value] of Object.entries(node)) {
            if (key === '$ref' && typeof value === 'string') refs.add(value);
            else collectRefs(value, refs);
        }
    }
    return refs;
}

function operation(path: string, method: string): Readonly<Record<string, unknown>> {
    const found = document.paths[path]?.[method.toLowerCase()];
    if (!found) throw new Error(`no operation ${method} ${path}`);
    return found;
}

describe('buildOpenApiDocument', () => {
    it('matches the committed openapi.json', () => {
        expect(
            JSON.parse(JSON.stringify(document)),
            'openapi.json is stale: run `bun run --filter @ptbk/engine-api openapi`',
        ).toEqual(committed);
    });

    it('validates as OpenAPI 3.1', async () => {
        const result = await new Validator().validate(JSON.parse(JSON.stringify(document)) as Record<string, unknown>);
        expect(result.errors).toBeUndefined();
        expect(result.valid).toBe(true);
    });

    it('rejects an invalid document, so the validation above means something', async () => {
        const broken = {
            ...(JSON.parse(JSON.stringify(document)) as Record<string, unknown>),
            paths: { '/me': { get: { responses: 'none' } } },
        };
        expect((await new Validator().validate(broken)).valid).toBe(false);
    });

    it('resolves every $ref to a component', () => {
        const refs = collectRefs(document, new Set());
        expect(refs.size).toBeGreaterThan(0);
        for (const ref of refs) {
            const name = /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1];
            expect(name, ref).toBeDefined();
            expect(document.components.schemas[name ?? ''], ref).toBeDefined();
        }
    });

    it('has one operation per route, with its ID', () => {
        for (const route of ENGINE_API_ROUTE_LIST) {
            expect(operation(route.path, route.method)['operationId']).toBe(route.id);
        }
    });

    it('lists the required permission and the 403 response of every protected operation', () => {
        for (const route of ENGINE_API_ROUTE_LIST) {
            const op = operation(route.path, route.method);
            const responses = op['responses'] as Readonly<Record<string, unknown>>;
            expect(op['x-required-permission'], route.id).toBe(route.permission);
            if (route.permission === null) {
                expect(responses['403'], route.id).toBeUndefined();
            } else {
                expect(responses['403'], route.id).toMatchObject({ 'x-problem-codes': ['forbidden'] });
            }
        }
        expect(operation('/me', 'GET')['x-required-permission']).toBeNull();
        expect(operation('/engine', 'GET')['x-required-permission']).toBeNull();
    });

    it('documents 404, not 403, on self-service credential routes', () => {
        for (const path of ['/me/passkeys/{passkeyId}', '/me/sessions/{sessionId}']) {
            const op = operation(path, 'DELETE');
            const responses = op['responses'] as Readonly<Record<string, unknown>>;
            expect(op['x-required-permission'], path).toBeNull();
            expect(op['description'], path).toContain('404');
            expect(responses['404'], path).toMatchObject({ 'x-problem-codes': ['not-found'] });
            expect(responses['403'], path).toBeUndefined();
        }
    });

    it('marks step-up and draft operations', () => {
        for (const route of ENGINE_API_ROUTE_LIST) {
            const op = operation(route.path, route.method);
            expect(op['x-step-up'], route.id).toBe(route.stepUp);
            expect(op['x-draft'], route.id).toBe(route.draft);
            expect(op['deprecated'], route.id).toBeUndefined();
        }
    });

    it('documents route-specific problems with problem+json', () => {
        const op = operation('/agents/{agentId}/source', 'PUT');
        const responses = op['responses'] as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
        expect(responses['409']?.['x-problem-codes']).toEqual(['agent-deleted', 'revision-conflict']);
        expect(responses['422']?.['x-problem-codes']).toEqual(['invalid-book']);
        expect(responses['422']?.['content']).toEqual({
            'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
        });
    });

    it('describes SSE routes with a Last-Event-ID header and an event-stream response', () => {
        const op = operation('/chats/{chatId}/messages/{messageId}/stream', 'GET');
        expect(op['parameters']).toContainEqual(expect.objectContaining({ name: 'Last-Event-ID', in: 'header' }));
        expect(op['responses']).toMatchObject({
            200: { content: { 'text/event-stream': { schema: { $ref: '#/components/schemas/ReplyStreamEvent' } } } },
        });
    });

    it('marks every capability operation with x-capability and its permission', () => {
        let capabilityOperations = 0;
        for (const route of ENGINE_API_ROUTE_LIST) {
            const op = operation(route.path, route.method);
            const responses = op['responses'] as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
            if (route.capability === undefined) {
                expect(op['x-capability'], route.id).toBeUndefined();
                expect(responses['404']?.['x-problem-codes'] ?? [], route.id).not.toContain('capability-not-supported');
                continue;
            }
            capabilityOperations += 1;
            expect(op['x-capability'], route.id).toEqual({
                id: route.capability.id,
                version: route.capability.version,
                label: capabilityLabel(route.capability),
            });
            expect(op['x-required-permission'], route.id).toBe(route.permission);
            expect(responses['404']?.['x-problem-codes'], route.id).toContain('capability-not-supported');
        }
        expect(capabilityOperations).toBeGreaterThan(20);
        expect(operation('/runs/{runId}/cancel', 'POST')['x-capability']).toMatchObject({ label: 'runs@1' });
    });

    it('documents route-specific capability problems', () => {
        const cancel = operation('/runs/{runId}/cancel', 'POST')['responses'] as Readonly<
            Record<string, Readonly<Record<string, unknown>>>
        >;
        expect(cancel['409']?.['x-problem-codes']).toEqual(['run-finished']);
        const create = operation('/triggers', 'POST')['responses'] as Readonly<
            Record<string, Readonly<Record<string, unknown>>>
        >;
        expect(create['422']?.['x-problem-codes']).toEqual(['invalid-schedule']);
        const download = operation('/files/{fileId}/content', 'GET')['responses'] as Readonly<
            Record<string, Readonly<Record<string, unknown>>>
        >;
        expect(download['409']?.['x-problem-codes']).toEqual(['file-infected']);
    });
});
