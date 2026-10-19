import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { isReadPermission } from './permissions';
import type { RouteDefinition } from './route';
import { ENGINE_API_ROUTES, ENGINE_API_ROUTE_LIST } from './routes';

const UNAUTHENTICATED_READS = new Set(['getMe', 'getEngine']);
const FORBIDDEN_RESPONSE_KEYS = new Set(['value', 'secret', 'token']);

function placeholders(path: string): string[] {
    return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '').sort();
}

function responseSchemas(route: RouteDefinition): z.ZodType[] {
    return Object.values(route.responses).flatMap((response) => {
        switch (response.kind) {
            case 'json':
                return [response.schema];
            case 'sse':
                return [response.event];
            case 'empty':
            case 'binary':
                return [];
        }
    });
}

/** Every property name anywhere in a JSON Schema, following properties, items, combinators and $defs. */
function propertyNames(node: unknown, names: Set<string>): Set<string> {
    if (Array.isArray(node)) {
        for (const item of node) propertyNames(item, names);
    } else if (typeof node === 'object' && node !== null) {
        for (const [key, value] of Object.entries(node as Readonly<Record<string, unknown>>)) {
            if (key === 'properties' && typeof value === 'object' && value !== null) {
                for (const name of Object.keys(value)) names.add(name);
            }
            propertyNames(value, names);
        }
    }
    return names;
}

function credentialKeys(route: RouteDefinition): string[] {
    const names = new Set<string>();
    for (const schema of responseSchemas(route)) {
        propertyNames(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }), names);
    }
    return [...names].filter((name) => FORBIDDEN_RESPONSE_KEYS.has(name.toLowerCase()));
}

describe('ENGINE_API_ROUTES', () => {
    it('keys every route by its unique operation ID', () => {
        for (const [key, route] of Object.entries(ENGINE_API_ROUTES)) expect(route.id).toBe(key);
        expect(new Set(ENGINE_API_ROUTE_LIST.map((route) => route.id)).size).toBe(ENGINE_API_ROUTE_LIST.length);
    });

    it('has one route per method and path', () => {
        const keys = ENGINE_API_ROUTE_LIST.map((route) => `${route.method} ${route.path}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('declares exactly the path placeholders as params', () => {
        for (const route of ENGINE_API_ROUTE_LIST) {
            expect(Object.keys(route.params?.shape ?? {}).sort(), route.id).toEqual(placeholders(route.path));
        }
    });

    it('requires a permission on every route except /me and /engine', () => {
        for (const route of ENGINE_API_ROUTE_LIST) {
            if (UNAUTHENTICATED_READS.has(route.id)) expect(route.permission, route.id).toBeNull();
            else expect(route.permission, route.id).not.toBeNull();
        }
        expect(ENGINE_API_ROUTES.getMe.path).toBe('/me');
        expect(ENGINE_API_ROUTES.getEngine.path).toBe('/engine');
    });

    it('requires a non-read permission on every mutating route', () => {
        for (const route of ENGINE_API_ROUTE_LIST.filter((candidate) => candidate.method !== 'GET')) {
            expect(route.permission, route.id).not.toBeNull();
            if (route.permission !== null) expect(isReadPermission(route.permission), route.id).toBe(false);
        }
    });

    it('declares exactly one success response', () => {
        for (const route of ENGINE_API_ROUTE_LIST) expect(Object.keys(route.responses), route.id).toHaveLength(1);
    });

    it('sends a body only with non-GET requests', () => {
        for (const route of ENGINE_API_ROUTE_LIST.filter((candidate) => candidate.body)) {
            expect(route.method, route.id).not.toBe('GET');
        }
    });

    it('requires step-up for the update policy, API token creation and passkey revocation', () => {
        expect(ENGINE_API_ROUTES.setUpdatePolicy.stepUp).toBe(true);
        expect(ENGINE_API_ROUTES.createApiToken.stepUp).toBe(true);
        expect(ENGINE_API_ROUTES.revokePasskey.stepUp).toBe(true);
    });

    it('never returns a value, secret or token field, except the new token from POST /api-tokens', () => {
        for (const route of ENGINE_API_ROUTE_LIST.filter((candidate) => candidate.id !== 'createApiToken')) {
            expect(credentialKeys(route), route.id).toEqual([]);
        }
        expect(credentialKeys(ENGINE_API_ROUTES.createApiToken)).toEqual(['token']);
    });
});
