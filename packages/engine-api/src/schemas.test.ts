import type { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { Agent, AgentListQuery } from './agents';
import { AuditEntry } from './audit';
import { ReplyStreamEvent } from './chats';
import { Hostname, PageQuery, ProblemDetails, SemVer, Timestamp } from './common';
import type { RouteDefinition } from './route';
import { ENGINE_API_ROUTE_LIST } from './routes';
import { CreateSecretBody, SecretMetadata } from './secrets';
import { SetUpdatePolicyBody } from './settings';

type Def = Readonly<Record<string, unknown>>;

function defOf(schema: z.core.$ZodType): Def {
    return schema._zod.def as unknown as Def;
}

function asSchema(value: unknown): z.core.$ZodType | undefined {
    return typeof value === 'object' && value !== null && '_zod' in value ? (value as z.core.$ZodType) : undefined;
}

/** Calls `visit` on every object schema nested anywhere in `schema`. */
function walkObjects(schema: z.core.$ZodType, visit: (def: Def) => void, seen = new Set<unknown>()): void {
    if (seen.has(schema)) return;
    seen.add(schema);
    const def = defOf(schema);
    const children: unknown[] = [];
    switch (def['type']) {
        case 'object':
            visit(def);
            children.push(...Object.values(def['shape'] as Def));
            break;
        case 'array':
            children.push(def['element']);
            break;
        case 'union':
            children.push(...(def['options'] as unknown[]));
            break;
        case 'intersection':
            children.push(def['left'], def['right']);
            break;
        case 'pipe':
            children.push(def['in'], def['out']);
            break;
        case 'record':
            children.push(def['valueType']);
            break;
        case 'tuple':
            children.push(...(def['items'] as unknown[]), def['rest']);
            break;
        default:
            children.push(def['innerType']);
    }
    for (const child of children) {
        const childSchema = asSchema(child);
        if (childSchema) walkObjects(childSchema, visit, seen);
    }
}

function routeSchemas(route: RouteDefinition): z.core.$ZodType[] {
    const schemas: z.core.$ZodType[] = [];
    if (route.params) schemas.push(route.params);
    if (route.query) schemas.push(route.query);
    if (route.body) schemas.push(route.body.schema);
    for (const response of Object.values(route.responses)) {
        if (response.kind === 'json') schemas.push(response.schema);
        if (response.kind === 'sse') schemas.push(response.event);
    }
    return schemas;
}

const NOW = '2026-10-19T12:00:00Z';
const SHA = 'a'.repeat(64);

const agent = {
    id: 'agt_1',
    permanentId: 'perm_1',
    name: 'Ada',
    profile: { fullname: 'Ada', description: '', avatarUrl: null, color: '#112233', initialMessage: null },
    visibility: 'private',
    folderId: null,
    currentRevisionId: 'rev_1',
    createdBy: 'mem_1',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
};
const secret = {
    id: 'sec_1',
    name: 'OPENAI_API_KEY',
    scope: { kind: 'agent', agentId: 'agt_1' },
    status: 'active',
    createdBy: 'mem_1',
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
};
const problem = {
    type: 'https://ptbk.io/problems/invalid-book',
    title: 'Invalid book',
    status: 422,
    code: 'invalid-book',
    diagnostics: [
        {
            severity: 'error',
            code: 'empty-book',
            message: 'Empty',
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
        },
    ],
};
const auditEntry = {
    id: 'aud_1',
    seq: 1,
    at: NOW,
    actor: { kind: 'api-token', apiTokenId: 'tok_1', memberId: 'mem_1' },
    action: 'secret.replace',
    target: { kind: 'secret', id: 'sec_1' },
    outcome: 'success',
    client: { ip: '203.0.113.7', userAgent: 'Firefox' },
    hash: SHA,
    prevHash: null,
};
const completedEvent = {
    type: 'completed',
    message: {
        id: 'msg_2',
        chatId: 'cht_1',
        role: 'agent',
        content: 'Hi',
        status: 'completed',
        createdBy: null,
        createdAt: NOW,
    },
};

const SAMPLES: readonly { name: string; schema: z.ZodType; sample: Record<string, unknown>; nested: string }[] = [
    { name: 'Agent', schema: Agent, sample: agent, nested: 'profile' },
    { name: 'SecretMetadata', schema: SecretMetadata, sample: secret, nested: 'scope' },
    { name: 'ProblemDetails', schema: ProblemDetails, sample: problem, nested: 'diagnostics.0.range' },
    { name: 'AuditEntry', schema: AuditEntry, sample: auditEntry, nested: 'actor' },
    { name: 'ReplyStreamEvent', schema: ReplyStreamEvent, sample: completedEvent, nested: 'message' },
    {
        name: 'CreateSecretBody',
        schema: CreateSecretBody,
        sample: { name: 'KEY', scope: { kind: 'engine' }, value: 's3cr3t' },
        nested: 'scope',
    },
    { name: 'AgentListQuery', schema: AgentListQuery, sample: { q: 'ada', limit: '20' }, nested: '' },
];

function withExtraField(sample: Record<string, unknown>, path: string): Record<string, unknown> {
    const copy = structuredClone(sample);
    let target: Record<string, unknown> = copy;
    for (const key of path.split('.').filter(Boolean)) target = target[key] as Record<string, unknown>;
    target['unexpected'] = true;
    return copy;
}

describe('strict schemas', () => {
    it('makes every object reachable from the route table and ProblemDetails strict', () => {
        const loose: string[] = [];
        let objects = 0;
        const roots: [string, z.core.$ZodType][] = [
            ['ProblemDetails', ProblemDetails],
            ...ENGINE_API_ROUTE_LIST.flatMap((route) =>
                routeSchemas(route).map((schema): [string, z.core.$ZodType] => [route.id, schema]),
            ),
        ];
        for (const [name, schema] of roots) {
            walkObjects(schema, (def) => {
                objects += 1;
                const catchall = asSchema(def['catchall']);
                if (!catchall || defOf(catchall)['type'] !== 'never') loose.push(name);
            });
        }
        expect(objects).toBeGreaterThan(50);
        expect(loose).toEqual([]);
    });

    for (const { name, schema, sample, nested } of SAMPLES) {
        it(`${name} accepts a valid sample and rejects unknown fields`, () => {
            expect(schema.safeParse(sample).error).toBeUndefined();
            expect(schema.safeParse(withExtraField(sample, '')).success).toBe(false);
            if (nested) expect(schema.safeParse(withExtraField(sample, nested)).success).toBe(false);
        });
    }
});

describe('Hostname', () => {
    it('lowercases', () => {
        expect(Hostname.parse('Agents.Example.COM')).toBe('agents.example.com');
    });

    it.each([
        ['trailing dot', 'example.com.'],
        ['single label', 'localhost'],
        ['IPv4 literal', '192.0.2.1'],
        ['IPv6 literal', '[::1]'],
        ['64-char label', `${'a'.repeat(64)}.example.com`],
        ['254-char name', `${'a.'.repeat(126)}ab`],
        ['empty label', 'a..example.com'],
        ['leading hyphen', '-a.example.com'],
        ['underscore', 'a_b.example.com'],
        ['Unicode', 'čau.example.com'],
    ])('refuses %s', (_label, hostname) => {
        expect(Hostname.safeParse(hostname).success).toBe(false);
    });

    it('accepts a 63-char label and digits in non-final labels', () => {
        expect(Hostname.safeParse(`${'a'.repeat(63)}.example.com`).success).toBe(true);
        expect(Hostname.safeParse('1.2.3.example').success).toBe(true);
    });
});

describe('SemVer', () => {
    it.each(['1.0.0', '0.1.2-rc.1', '1.2.3+build.5', '10.20.30-alpha.beta+exp.sha.5114f85'])('accepts %s', (v) => {
        expect(SemVer.safeParse(v).success).toBe(true);
    });

    it.each(['1.0', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0-01', ''])('refuses %s', (v) => {
        expect(SemVer.safeParse(v).success).toBe(false);
    });
});

describe('Timestamp', () => {
    it('accepts UTC with any precision and refuses offsets and dates', () => {
        expect(Timestamp.safeParse('2026-10-19T12:00:00Z').success).toBe(true);
        expect(Timestamp.safeParse('2026-10-19T12:00:00.123456Z').success).toBe(true);
        expect(Timestamp.safeParse('2026-10-19T12:00:00+02:00').success).toBe(false);
        expect(Timestamp.safeParse('2026-10-19').success).toBe(false);
    });
});

describe('SetUpdatePolicyBody', () => {
    it('requires pinnedVersion exactly when the policy is pinned', () => {
        expect(SetUpdatePolicyBody.safeParse({ policy: 'auto' }).success).toBe(true);
        expect(SetUpdatePolicyBody.safeParse({ policy: 'manual' }).success).toBe(true);
        expect(SetUpdatePolicyBody.safeParse({ policy: 'pinned', pinnedVersion: '1.8.2' }).success).toBe(true);
        expect(SetUpdatePolicyBody.safeParse({ policy: 'pinned' }).success).toBe(false);
        expect(SetUpdatePolicyBody.safeParse({ policy: 'auto', pinnedVersion: '1.8.2' }).success).toBe(false);
        expect(SetUpdatePolicyBody.safeParse({ policy: 'pinned', pinnedVersion: 'latest' }).success).toBe(false);
    });
});

describe('PageQuery', () => {
    it('coerces a string limit and defaults to 50', () => {
        expect(PageQuery.parse({ limit: '20' })).toEqual({ limit: 20 });
        expect(PageQuery.parse({})).toEqual({ limit: 50 });
    });

    it.each(['0', '101', '1.5', 'ten'])('refuses limit %s', (limit) => {
        expect(PageQuery.safeParse({ limit }).success).toBe(false);
    });
});
