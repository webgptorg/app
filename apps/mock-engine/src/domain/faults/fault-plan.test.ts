import { describe, expect, it } from 'vitest';

import { FaultPlan, NO_FAULTS, matchesRoutes, parseFaultPlanJson } from './fault-plan';

describe('FaultPlan', () => {
    it('defaults every field to no faults', () => {
        expect(NO_FAULTS).toEqual({
            latencyMs: { min: 0, max: 0 },
            errorRate: 0,
            errorStatus: 503,
            dropStreamRate: 0,
            slowTunnelBytesPerS: null,
            runFailureRate: null,
            stuckQueue: false,
            scanInfectedRate: 0,
            integrationErrorRate: 0,
        });
    });

    it('accepts a full plan', () => {
        const plan = FaultPlan.parse({
            latencyMs: { min: 10, max: 50 },
            errorRate: 0.25,
            errorStatus: 502,
            dropStreamRate: 1,
            slowTunnelBytesPerS: 4096,
            routes: ['/api/v1/agents/**'],
        });
        expect(plan.routes).toEqual(['/api/v1/agents/**']);
    });

    it.each([
        ['unknown field', { chaos: true }],
        ['unknown nested field', { latencyMs: { min: 0, max: 1, avg: 0 } }],
        ['min above max', { latencyMs: { min: 5, max: 1 } }],
        ['latency over the cap', { latencyMs: { min: 0, max: 60_001 } }],
        ['fractional latency', { latencyMs: { min: 0.5, max: 1 } }],
        ['rate above 1', { errorRate: 1.5 }],
        ['negative rate', { dropStreamRate: -0.1 }],
        ['unsupported status', { errorStatus: 504 }],
        ['tiny throttle', { slowTunnelBytesPerS: 1 }],
        ['empty routes', { routes: [] }],
        ['relative glob', { routes: ['api/*'] }],
        ['too many globs', { routes: Array.from({ length: 33 }, () => '/x') }],
    ])('rejects %s', (_, input) => {
        expect(FaultPlan.safeParse(input).success).toBe(false);
    });
});

describe('parseFaultPlanJson', () => {
    it('parses a valid plan', () => {
        expect(parseFaultPlanJson('{"errorRate":0.5}')).toEqual({ kind: 'ok', plan: { ...NO_FAULTS, errorRate: 0.5 } });
    });

    it('names problems without echoing values', () => {
        const result = parseFaultPlanJson('{"errorRate":"sekrit-value","sekritKey":1}');
        expect(result.kind).toBe('invalid');
        expect(JSON.stringify(result)).not.toContain('sekrit');
        expect(result).toMatchObject({ problems: expect.arrayContaining(['errorRate: invalid_type']) as unknown });
        expect(parseFaultPlanJson('{"latencyMs":{"min":9,"max":1}}')).toEqual({
            kind: 'invalid',
            problems: ['latencyMs.max: custom'],
        });
    });

    it('rejects bad JSON and oversized input', () => {
        expect(parseFaultPlanJson('{nope')).toEqual({ kind: 'invalid', problems: ['is not valid JSON'] });
        expect(parseFaultPlanJson(' '.repeat(16 * 1024 + 1))).toEqual({ kind: 'invalid', problems: ['is too long'] });
    });
});

describe('matchesRoutes', () => {
    const plan = (routes: string[]) => FaultPlan.parse({ routes });

    it('matches every path without routes', () => {
        expect(matchesRoutes(NO_FAULTS, '/anything')).toBe(true);
    });

    it('treats * as one segment and ** as any depth', () => {
        expect(matchesRoutes(plan(['/api/v1/agents/*']), '/api/v1/agents/a1')).toBe(true);
        expect(matchesRoutes(plan(['/api/v1/agents/*']), '/api/v1/agents/a1/chats')).toBe(false);
        expect(matchesRoutes(plan(['/api/v1/**']), '/api/v1/agents/a1/chats')).toBe(true);
        expect(matchesRoutes(plan(['/api/v1/**/stream']), '/api/v1/chats/c/messages/m/stream')).toBe(true);
        expect(matchesRoutes(plan(['/api/v1/me']), '/api/v1/me')).toBe(true);
        expect(matchesRoutes(plan(['/api/v1/me']), '/api/v1/me/sessions')).toBe(false);
    });

    it('takes every other character literally', () => {
        expect(matchesRoutes(plan(['/a.b']), '/a.b')).toBe(true);
        expect(matchesRoutes(plan(['/a.b']), '/aXb')).toBe(false);
        expect(matchesRoutes(plan(['/(x)+?']), '/(x)+?')).toBe(true);
    });

    it('matches when any glob does', () => {
        expect(matchesRoutes(plan(['/x', '/events']), '/events')).toBe(true);
    });
});
