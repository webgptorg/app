import type { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { Agent, AgentListQuery } from './agents';
import { AuditEntry } from './audit';
import { Activity } from './capabilities/activity';
import { FileMetadata, FileVersion } from './capabilities/files';
import { activitySample } from './capabilities/fixtures/samples';
import { CreateIntegrationBody, Integration } from './capabilities/integrations';
import { Money, Run, RunDetail, RunListQuery, RunText } from './capabilities/runs';
import { CreateTriggerBody, Recurrence, Trigger, TriggerFire } from './capabilities/triggers';
import { MAX_CHAT_PREVIEW_LENGTH, MAX_RUN_TEXT_BYTES } from './constants';
import { EngineInfo } from './engine';
import { Chat, ReplyStreamEvent } from './chats';
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

const run = {
    id: 'run_1',
    agentId: 'agt_1',
    source: 'schedule',
    status: 'completed',
    chatId: null,
    messageId: null,
    triggerId: 'trg_1',
    retryOf: null,
    createdBy: null,
    queuedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    cancelRequestedAt: null,
    attemptCount: 1,
    runner: 'claude-code',
    model: null,
    progress: { title: 'Digest', now: null, next: null, items: [{ id: '1', text: 'Read mail', status: 'completed' }] },
    usage: { inputTokens: 10, outputTokens: 5, durationMs: 1000, cost: { amount: '0.01', currency: 'EUR' } },
    error: null,
};
const runDetail = {
    ...run,
    toolCalls: [
        {
            id: 'tc_1',
            name: 'read_mail',
            state: 'complete',
            startedAt: NOW,
            durationMs: 20,
            logs: 'ok',
            logsTruncated: false,
        },
    ],
    outputs: {
        messages: [{ chatId: 'cht_1', messageId: 'msg_1' }],
        files: ['fil_1'],
        projectChanges: [
            {
                projectName: 'site',
                commitHash: 'b'.repeat(40),
                changedFiles: [{ path: 'index.html', insertions: 3, deletions: 1 }],
                diff: '+hello',
                diffTruncated: false,
            },
        ],
    },
    report: { touchedProjects: ['site'], externalSources: ['example.com'] },
};
const fileMetadata = {
    id: 'fil_1',
    name: 'notes.txt',
    contentType: 'text/plain',
    sizeBytes: 5,
    sha256: SHA,
    purpose: 'knowledge',
    agentId: 'agt_1',
    chatId: null,
    runId: null,
    scan: { status: 'clean', checkedAt: NOW },
    versionCount: 1,
    createdBy: 'mem_1',
    createdAt: NOW,
};
const fileVersion = { id: 'fv_1', createdAt: NOW, sizeBytes: 5, sha256: SHA, commitHash: null, runId: 'run_1' };
const trigger = {
    id: 'trg_1',
    agentId: 'agt_1',
    name: 'Daily digest',
    kind: 'schedule',
    lifecycle: 'active',
    endedReason: null,
    lastFiredAt: null,
    nextFireAt: NOW,
    createdBy: 'mem_1',
    createdAt: NOW,
    updatedAt: NOW,
    config: {
        recurrence: { kind: 'cron', expression: '0 8 * * 1-5', timeZone: 'Europe/Prague' },
        startsAt: NOW,
        endsAt: null,
        maxRunCount: null,
        runCount: 0,
        message: 'Summarise my inbox',
    },
};
const triggerFire = { id: 'tf_1', at: NOW, outcome: 'started', runId: 'run_1', error: null };
const integration = {
    id: 'int_1',
    agentId: null,
    name: 'Docs MCP',
    kind: 'mcp-server',
    status: 'connected',
    statusDetail: null,
    scopes: ['read'],
    secretRefs: [{ name: 'DOCS_TOKEN', secretId: 'sec_1', state: 'resolved' }],
    tools: [{ name: 'search', description: null }],
    lastActivityAt: null,
    createdBy: 'mem_1',
    createdAt: NOW,
    updatedAt: NOW,
    config: { url: 'https://mcp.example.com/sse' },
};
const engineInfo = {
    name: 'Home',
    engineId: 'abcdefghijklmnopqrstuvwxyz',
    hostname: 'abcdefghijklmnopqrstuvwxyz.ptbk.example',
    dashboardUrl: null,
    mode: 'local',
    capabilities: [{ id: 'runs', version: 1 }],
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
    { name: 'EngineInfo', schema: EngineInfo, sample: engineInfo, nested: 'capabilities.0' },
    { name: 'Run', schema: Run, sample: run, nested: 'progress.items.0' },
    { name: 'RunDetail', schema: RunDetail, sample: runDetail, nested: 'outputs.projectChanges.0.changedFiles.0' },
    { name: 'RunDetail tool call', schema: RunDetail, sample: runDetail, nested: 'toolCalls.0' },
    { name: 'FileMetadata', schema: FileMetadata, sample: fileMetadata, nested: 'scan' },
    { name: 'FileVersion', schema: FileVersion, sample: fileVersion, nested: '' },
    { name: 'Trigger', schema: Trigger, sample: trigger, nested: 'config.recurrence' },
    { name: 'TriggerFire', schema: TriggerFire, sample: triggerFire, nested: '' },
    { name: 'Integration', schema: Integration, sample: integration, nested: 'secretRefs.0' },
    { name: 'Integration config', schema: Integration, sample: integration, nested: 'config' },
    {
        name: 'CreateTriggerBody',
        schema: CreateTriggerBody,
        sample: {
            kind: 'schedule',
            agentId: 'agt_1',
            name: 'Hourly',
            recurrence: { kind: 'interval', everySeconds: 3600 },
            message: 'Check',
        },
        nested: 'recurrence',
    },
    {
        name: 'CreateIntegrationBody',
        schema: CreateIntegrationBody,
        sample: {
            kind: 'repository',
            name: 'Site',
            provider: 'github',
            repository: 'webgptorg/app',
            secretNames: ['GITHUB_TOKEN'],
        },
        nested: '',
    },
    { name: 'Activity', schema: Activity, sample: activitySample('run.completed'), nested: 'actor' },
    { name: 'Activity usage', schema: Activity, sample: activitySample('run.completed'), nested: 'usage.cost' },
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

describe('Chat', () => {
    const chat = {
        id: 'c1',
        agentId: 'a1',
        title: 'Billing',
        source: 'web',
        createdBy: 'm1',
        createdAt: '2026-10-19T12:00:00Z',
        updatedAt: '2026-10-19T12:00:00Z',
        messageCount: 0,
        lastMessageAt: null,
        preview: null,
    };

    it('accepts a member chat and one no member started, and rejects unknown fields', () => {
        expect(Chat.safeParse(chat).error).toBeUndefined();
        expect(Chat.safeParse({ ...chat, createdBy: null, source: 'api' }).error).toBeUndefined();
        expect(Chat.safeParse({ ...chat, unexpected: true }).success).toBe(false);
    });

    it('takes only run sources, a whole message count and a bounded preview', () => {
        expect(Chat.safeParse({ ...chat, source: 'kiosk' }).success).toBe(false);
        expect(Chat.safeParse({ ...chat, messageCount: 1.5 }).success).toBe(false);
        expect(Chat.safeParse({ ...chat, preview: 'x'.repeat(MAX_CHAT_PREVIEW_LENGTH) }).success).toBe(true);
        expect(Chat.safeParse({ ...chat, preview: 'x'.repeat(MAX_CHAT_PREVIEW_LENGTH + 1) }).success).toBe(false);
    });
});

describe('capability schema details', () => {
    it('reads a run status filter as a set of statuses', () => {
        expect(RunListQuery.parse({ status: 'queued,running,queued' }).status).toEqual(['queued', 'running']);
        expect(RunListQuery.parse({}).sort).toBe('-queuedAt');
        expect(RunListQuery.safeParse({ status: 'queued,bogus' }).success).toBe(false);
        expect(RunListQuery.safeParse({ status: 'queued,' }).success).toBe(false);
    });

    it('bounds run text by UTF-8 bytes, not characters', () => {
        expect(RunText.safeParse('a'.repeat(MAX_RUN_TEXT_BYTES)).success).toBe(true);
        expect(RunText.safeParse('a'.repeat(MAX_RUN_TEXT_BYTES + 1)).success).toBe(false);
        const multiByte = 'č'.repeat(MAX_RUN_TEXT_BYTES / 2 + 1);
        expect(multiByte.length).toBeLessThan(MAX_RUN_TEXT_BYTES);
        expect(RunText.safeParse(multiByte).success).toBe(false);
    });

    it('takes money only as a decimal string with an ISO 4217 currency', () => {
        expect(Money.safeParse({ amount: '12.50', currency: 'USD' }).success).toBe(true);
        expect(Money.safeParse({ amount: 12.5, currency: 'USD' }).success).toBe(false);
        expect(Money.safeParse({ amount: '-1', currency: 'USD' }).success).toBe(false);
        expect(Money.safeParse({ amount: '1e3', currency: 'USD' }).success).toBe(false);
        expect(Money.safeParse({ amount: '1', currency: 'usd' }).success).toBe(false);
        expect(Money.safeParse({ amount: '1', currency: 'EURO' }).success).toBe(false);
    });

    it('refuses intervals under a minute', () => {
        expect(Recurrence.safeParse({ kind: 'interval', everySeconds: 60 }).success).toBe(true);
        expect(Recurrence.safeParse({ kind: 'interval', everySeconds: 59 }).success).toBe(false);
        expect(Recurrence.safeParse({ kind: 'interval', everySeconds: 90.5 }).success).toBe(false);
    });

    it('refuses webhook triggers on create and integrations without a known kind', () => {
        expect(CreateTriggerBody.safeParse({ kind: 'webhook', agentId: 'agt_1', name: 'Hook' }).success).toBe(false);
        expect(
            CreateIntegrationBody.safeParse({ kind: 'calendar', name: 'Cal', provider: 'google', account: 'a' })
                .success,
        ).toBe(false);
        expect(
            CreateIntegrationBody.safeParse({ kind: 'mcp-server', name: 'Plain', url: 'http://mcp.example.com' })
                .success,
        ).toBe(false);
    });
});
