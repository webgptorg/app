import type { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { Agent, AgentListQuery } from './agents';
import { AuditEntry, AuditPageReader, isAuditAction } from './audit';
import { Activity } from './capabilities/activity';
import { FileMetadata, FileVersion } from './capabilities/files';
import { activitySample } from './capabilities/fixtures/samples';
import {
    CreateIntegrationBody,
    Integration,
    IntegrationListQuery,
    IntegrationPageReader,
    IntegrationReader,
    IntegrationStats,
} from './capabilities/integrations';
import {
    Money,
    Run,
    RunDetail,
    RunDetailReader,
    RunListQuery,
    RunPageReader,
    RunReader,
    RunStats,
    RunText,
} from './capabilities/runs';
import { CreateTriggerBody, Recurrence, Trigger, TriggerFire } from './capabilities/triggers';
import {
    MAX_AUDIT_DETAILS_BYTES,
    MAX_AUDIT_DETAILS_DEPTH,
    MAX_AUDIT_TARGET_NAME_LENGTH,
    MAX_CHAT_PREVIEW_LENGTH,
    MAX_RUN_PREVIEW_LENGTH,
    MAX_RUN_TEXT_BYTES,
} from './constants';
import { EngineInfo } from './engine';
import { Chat, ReplyStreamEvent } from './chats';
import { Hostname, PageQuery, ProblemDetails, SemVer, Timestamp } from './common';
import type { RouteDefinition } from './route';
import { ENGINE_API_ROUTE_LIST } from './routes';
import { Member } from './members';
import { Passkey, PasskeyPageReader } from './passkeys';
import { CreateSecretBody, SecretMetadata } from './secrets';
import { RekorEntryUuid, SecurityOverview, SecurityOverviewReader, UiUpdateCheck } from './security';
import { Session } from './sessions';
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
    origin: 'content',
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
    agentName: 'Iris',
    source: 'schedule',
    status: 'completed',
    chatId: null,
    messageId: null,
    triggerId: 'trg_1',
    retryOf: null,
    taskId: null,
    occurrenceId: null,
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
    preview: 'Send the daily digest',
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
        fileNames: ['digest.md'],
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
    agentName: 'Ada',
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

/** A `GET /security` answer as an engine on API 1.2 sends it, without any field 1.3 added. */
const securityV12 = {
    engine: { version: '1.4.0', releaseLogIndex: 7 },
    update: { status: 'none', policy: 'auto', pinnedVersion: null, availableVersion: null, eligibleAt: null },
    ui: { version: '1.4.0', bundleSha256: SHA, releaseLogIndex: 8 },
    tls: { certificateSha256: SHA, notAfter: NOW, lastCtCheck: { at: NOW, result: 'ok' } },
    relays: [{ hostname: 'relay-a.ptbk.io', status: 'connected', since: NOW }],
    hostnames: [{ hostname: 'e.ptbk.io', kind: 'default' }],
    lastHeartbeat: { sentAt: NOW, body: '{"v":1}' },
    outboundDestinations: [],
};

const securityV13 = {
    ...securityV12,
    engine: { ...securityV12.engine, releaseLogEntryUuid: `${'b'.repeat(16)}${'c'.repeat(64)}` },
    ui: {
        ...securityV12.ui,
        releaseLogEntryUuid: 'd'.repeat(64),
        lastUpdateCheck: {
            at: NOW,
            outcome: 'refused',
            version: '1.5.0',
            reason: 'revocations-unverifiable',
            revocationReason: 'rolled-back',
        },
    },
    tls: {
        ...securityV12.tls,
        lastCtCheck: {
            at: NOW,
            result: 'unexpected-certificate',
            unexpectedCertificates: [{ sha256: SHA, issuer: 'CN=Some CA', notBefore: NOW, notAfter: NOW }],
        },
    },
    relays: [{ ...securityV12.relays[0], lastPingRttMs: 42 }],
    hostnames: [
        { hostname: 'e.ptbk.io', kind: 'default', certificateStatus: 'valid', claimRegistered: null },
        { hostname: 'ai.example.com', kind: 'custom', certificateStatus: 'pending', claimRegistered: true },
    ],
    lastHeartbeat: { ...securityV12.lastHeartbeat, signature: `ed25519=${'A'.repeat(86)}` },
    clockSkew: { seconds: -300, measuredAt: NOW },
};

/** What a 1.3 answer parses to since API 1.10 defaults `eligibleAt`. */
const securityV13Parsed = {
    ...securityV13,
    ui: { ...securityV13.ui, lastUpdateCheck: { ...securityV13.ui.lastUpdateCheck, eligibleAt: null } },
};

describe('SecurityOverview (API 1.3 fields)', () => {
    it('reads a 1.2 answer with every new field as null or empty', () => {
        const overview = SecurityOverview.parse(securityV12);
        expect(overview.engine.releaseLogEntryUuid).toBeNull();
        expect(overview.ui).toMatchObject({ releaseLogEntryUuid: null, lastUpdateCheck: null });
        expect(overview.tls.lastCtCheck?.unexpectedCertificates).toEqual([]);
        expect(overview.relays[0]?.lastPingRttMs).toBeNull();
        expect(overview.hostnames[0]).toMatchObject({ certificateStatus: null, claimRegistered: null });
        expect(overview.lastHeartbeat?.signature).toBeNull();
        expect(overview.clockSkew).toBeNull();
    });

    it('accepts every 1.3 field and still rejects unknown ones', () => {
        expect(SecurityOverview.parse(securityV13)).toEqual(securityV13Parsed);
        expect(SecurityOverview.safeParse({ ...securityV13, extra: 1 }).success).toBe(false);
    });

    it('takes a Rekor entry UUID with or without the tree ID, in lowercase hex only', () => {
        expect(RekorEntryUuid.safeParse('a'.repeat(64)).success).toBe(true);
        expect(RekorEntryUuid.safeParse('a'.repeat(80)).success).toBe(true);
        expect(RekorEntryUuid.safeParse('a'.repeat(72)).success).toBe(false);
        expect(RekorEntryUuid.safeParse('A'.repeat(64)).success).toBe(false);
    });

    it('bounds the certificates a CT check reports and the relay round trip', () => {
        const certificate = securityV13.tls.lastCtCheck.unexpectedCertificates[0];
        const tooMany = { ...securityV13.tls.lastCtCheck, unexpectedCertificates: Array(17).fill(certificate) };
        expect(
            SecurityOverview.safeParse({ ...securityV13, tls: { ...securityV13.tls, lastCtCheck: tooMany } }).success,
        ).toBe(false);
        const negative = [{ ...securityV13.relays[0], lastPingRttMs: -1 }];
        expect(SecurityOverview.safeParse({ ...securityV13, relays: negative }).success).toBe(false);
    });

    it('reads check outcomes, reasons and certificate statuses it does not know as unknown', () => {
        const newer = {
            ...securityV13,
            ui: {
                ...securityV13.ui,
                lastUpdateCheck: {
                    ...securityV13.ui.lastUpdateCheck,
                    outcome: 'deferred',
                    reason: 'quarantined',
                    revocationReason: 'stale',
                },
            },
            hostnames: [{ ...securityV13.hostnames[0], certificateStatus: 'revoked' }],
        };
        expect(SecurityOverview.safeParse(newer).success).toBe(false);
        const read = SecurityOverviewReader.parse(newer);
        expect(read.ui.lastUpdateCheck).toMatchObject({
            outcome: 'unknown',
            reason: 'unknown',
            revocationReason: 'unknown',
        });
        expect(read.hostnames[0]?.certificateStatus).toBe('unknown');
        expect(SecurityOverviewReader.parse(securityV13)).toEqual(securityV13Parsed);
    });
});

describe('UiUpdateCheck.eligibleAt (API 1.10)', () => {
    const delayed = {
        at: NOW,
        outcome: 'refused',
        version: '1.5.0',
        reason: 'delay-not-elapsed',
        revocationReason: null,
        eligibleAt: '2026-10-22T08:00:00Z',
    };

    it('reads a check from an engine before 1.10 with eligibleAt as null', () => {
        expect(SecurityOverview.parse(securityV13).ui.lastUpdateCheck?.eligibleAt).toBeNull();
        expect(SecurityOverviewReader.parse(securityV13).ui.lastUpdateCheck?.eligibleAt).toBeNull();
    });

    it('carries when a delayed release becomes eligible', () => {
        expect(UiUpdateCheck.parse(delayed)).toEqual(delayed);
        const overview = { ...securityV13, ui: { ...securityV13.ui, lastUpdateCheck: delayed } };
        expect(SecurityOverviewReader.parse(overview).ui.lastUpdateCheck?.eligibleAt).toBe(delayed.eligibleAt);
    });

    it('refuses an eligibleAt that is not a timestamp', () => {
        expect(UiUpdateCheck.safeParse({ ...delayed, eligibleAt: 'in three days' }).success).toBe(false);
        expect(UiUpdateCheck.safeParse({ ...delayed, eligibleAt: 1_761_120_000 }).success).toBe(false);
    });
});

describe('passkeys, sessions, members and secrets (API 1.3 fields)', () => {
    const passkey = { id: 'pk_1', memberId: 'mem_1', name: 'iPhone', createdAt: NOW, lastUsedAt: null };

    it('reads 1.2 records with the new fields as null', () => {
        expect(Passkey.parse(passkey).authenticator).toBeNull();
        expect(
            Session.parse({
                id: 'ses_1',
                memberId: 'mem_1',
                current: true,
                client: null,
                createdAt: NOW,
                lastSeenAt: NOW,
                expiresAt: NOW,
            }).passkeyId,
        ).toBeNull();
        const member = {
            id: 'mem_1',
            displayName: 'Ada',
            role: 'owner',
            status: 'active',
            createdAt: NOW,
            lastSeenAt: null,
        };
        expect(Member.parse(member).passkeyCount).toBeNull();
        expect(Member.safeParse({ ...member, passkeyCount: -1 }).success).toBe(false);
        expect(SecretMetadata.parse(secret).valueUpdatedAt).toBeNull();
    });

    it('reads an authenticator attachment it does not know as unknown', () => {
        const roaming = { ...passkey, authenticator: { attachment: 'cross-platform', backedUp: false } };
        const hybrid = { ...passkey, id: 'pk_2', authenticator: { attachment: 'hybrid', backedUp: null } };
        expect(Passkey.safeParse(hybrid).success).toBe(false);
        expect(PasskeyPageReader.parse({ items: [roaming, hybrid], nextCursor: null }).items).toEqual([
            roaming,
            { ...hybrid, authenticator: { attachment: 'unknown', backedUp: null } },
        ]);
    });
});

describe('AuditEntry (API 1.4 fields)', () => {
    const nested = (depth: number): Record<string, unknown> => {
        let value: Record<string, unknown> = { leaf: true };
        for (let level = 1; level < depth; level++) value = { level: value };
        return value;
    };

    it('reads a 1.3 entry without details or target name', () => {
        expect(AuditEntry.parse(auditEntry)).not.toHaveProperty('details');
    });

    it('takes a target name snapshot and details within the limits', () => {
        const entry = {
            ...auditEntry,
            target: { kind: 'secret', id: 'sec_1', name: '<img src=x onerror=alert(1)>' },
            details: { fields: ['value'], nested: nested(MAX_AUDIT_DETAILS_DEPTH - 1) },
        };
        expect(AuditEntry.parse(entry)).toEqual(entry);
        expect(
            AuditEntry.parse({ ...auditEntry, target: { ...auditEntry.target, name: null }, details: null }),
        ).toBeTruthy();
    });

    it('refuses a long target name, deep or large details and details that are not an object', () => {
        const name = 'x'.repeat(MAX_AUDIT_TARGET_NAME_LENGTH + 1);
        expect(AuditEntry.safeParse({ ...auditEntry, target: { ...auditEntry.target, name } }).success).toBe(false);
        expect(AuditEntry.safeParse({ ...auditEntry, details: nested(MAX_AUDIT_DETAILS_DEPTH) }).success).toBe(true);
        expect(AuditEntry.safeParse({ ...auditEntry, details: nested(MAX_AUDIT_DETAILS_DEPTH + 1) }).success).toBe(
            false,
        );
        expect(AuditEntry.safeParse({ ...auditEntry, details: nested(100_000) }).success).toBe(false);
        const large = { text: 'é'.repeat(MAX_AUDIT_DETAILS_BYTES / 2) };
        expect(AuditEntry.safeParse({ ...auditEntry, details: large }).success).toBe(false);
        expect(AuditEntry.safeParse({ ...auditEntry, details: ['a'] }).success).toBe(false);
        expect(AuditEntry.safeParse({ ...auditEntry, details: 'a' }).success).toBe(false);
        expect(AuditEntry.safeParse({ ...auditEntry, details: { n: 1n } }).success).toBe(false);
        expect(AuditEntry.safeParse({ ...auditEntry, details: () => ({}) }).success).toBe(false);
    });

    it('keeps the engine side closed to unknown actions while the client keeps their raw name', () => {
        const newer = { ...auditEntry, action: 'agent.clone', extra: 1 };
        expect(AuditEntry.safeParse(newer).success).toBe(false);
        const read = AuditPageReader.parse({ items: [newer], nextCursor: null });
        expect(read.items[0]?.action).toBe('agent.clone');
        expect(read.items[0]).not.toHaveProperty('extra');
        expect(isAuditAction('agent.clone')).toBe(false);
        expect(isAuditAction('secret.replace')).toBe(true);
        for (const action of ['Agent.Clone', 'agent', 'agent.', '<img>.x', 'a.' + 'b'.repeat(64)]) {
            expect(AuditPageReader.safeParse({ items: [{ ...auditEntry, action }], nextCursor: null }).success).toBe(
                false,
            );
        }
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
    it('names each output file, in order, and bounds the run preview', () => {
        expect(RunDetail.safeParse({ ...runDetail, outputs: { ...runDetail.outputs, fileNames: [] } }).success).toBe(
            false,
        );
        expect(Run.safeParse({ ...run, preview: 'x'.repeat(MAX_RUN_PREVIEW_LENGTH) }).success).toBe(true);
        expect(Run.safeParse({ ...run, preview: 'x'.repeat(MAX_RUN_PREVIEW_LENGTH + 1) }).success).toBe(false);
        expect(Run.safeParse({ ...run, agentName: '' }).success).toBe(false);
    });

    it('reports the last finished run in stats, only with a terminal status', () => {
        const stats = { running: 0, queued: 0, failedLast24h: 1, oldestQueuedAt: null };
        expect(RunStats.safeParse({ ...stats, lastFinished: { status: 'failed', at: NOW } }).success).toBe(true);
        expect(RunStats.safeParse({ ...stats, lastFinished: null }).success).toBe(true);
        expect(RunStats.safeParse({ ...stats, lastFinished: { status: 'running', at: NOW } }).success).toBe(false);
        expect(RunStats.safeParse(stats).success).toBe(false);
    });

    it('reads a run status or source a newer engine added as unknown, and strips unknown fields', () => {
        const read = RunReader.parse({ ...run, status: 'paused', source: 'kiosk', extra: 1 });
        expect(read.status).toBe('unknown');
        expect(read.source).toBe('unknown');
        expect(read).not.toHaveProperty('extra');
        const detail = RunDetailReader.parse({ ...runDetail, status: 'paused' });
        expect(detail.status).toBe('unknown');
        expect(detail.outputs.fileNames).toEqual(['digest.md']);
        expect(RunPageReader.parse({ items: [{ ...run, source: 'kiosk' }], nextCursor: null }).items[0]?.source).toBe(
            'unknown',
        );
    });

    it('reads a run status filter as a set of statuses', () => {
        expect(RunListQuery.parse({ status: 'queued,running,queued' }).status).toEqual(['queued', 'running']);
        expect(RunListQuery.parse({}).sort).toBe('-queuedAt');
        expect(RunListQuery.safeParse({ status: 'queued,bogus' }).success).toBe(false);
        expect(RunListQuery.safeParse({ status: 'queued,' }).success).toBe(false);
    });

    it('reads an integration status filter as a set and engine-wide inclusion as a flag', () => {
        const query = IntegrationListQuery.parse({ status: 'error,needs-attention,error', includeEngineWide: 'true' });
        expect(query.status).toEqual(['error', 'needs-attention']);
        expect(query.includeEngineWide).toBe(true);
        expect(IntegrationListQuery.parse({ includeEngineWide: 'false' }).includeEngineWide).toBe(false);
        expect(IntegrationListQuery.safeParse({ status: 'error,paused' }).success).toBe(false);
        expect(IntegrationListQuery.safeParse({ includeEngineWide: 'yes' }).success).toBe(false);
    });

    it('counts integrations by every status, nothing else', () => {
        const stats = { connected: 1, needsAttention: 2, disconnected: 0, error: 3 };
        expect(IntegrationStats.parse(stats)).toEqual(stats);
        expect(IntegrationStats.safeParse({ ...stats, error: -1 }).success).toBe(false);
        expect(IntegrationStats.safeParse({ ...stats, paused: 0 }).success).toBe(false);
        expect(IntegrationStats.safeParse({ ...stats, error: undefined }).success).toBe(false);
    });

    it('reads an integration status or secret state a newer engine added as unknown', () => {
        const newer = {
            ...integration,
            status: 'paused',
            secretRefs: [{ name: 'DOCS_TOKEN', secretId: 'sec_1', state: 'expired' }],
        };
        expect(Integration.safeParse(newer).success).toBe(false);
        const read = IntegrationReader.parse(newer);
        expect(read.status).toBe('unknown');
        expect(read.secretRefs[0]?.state).toBe('unknown');
        const unknownKind = IntegrationPageReader.parse({
            items: [{ ...newer, kind: 'slack', config: { workspace: 'acme' } }],
            nextCursor: null,
        }).items[0];
        expect(unknownKind).toMatchObject({ kind: 'unknown', rawKind: 'slack', status: 'unknown' });
        expect(IntegrationReader.parse(integration)).toEqual(integration);
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
