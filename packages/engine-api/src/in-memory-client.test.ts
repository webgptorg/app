import { describe, expect, it } from 'vitest';

import { AuditEntry } from './audit';
import type { EngineApiResponse } from './client';
import { Timestamp } from './common';
import { verifyAuditChain } from './in-memory/audit-chain';
import { checkBook } from './in-memory/book';
import { paginate } from './in-memory/paging';
import { createInMemoryEngineApiClient, IN_MEMORY_CLIENT_MARKER } from './in-memory-client';

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

const signal = () => AbortSignal.timeout(5_000);

describe('createInMemoryEngineApiClient', () => {
    it('carries the marker a production bundle is checked for', () => {
        expect(Object.prototype.toString.call(createInMemoryEngineApiClient())).toContain(IN_MEMORY_CLIENT_MARKER);
    });

    it('seeds agents from book source, including other members', async () => {
        const client = createInMemoryEngineApiClient({
            seed: {
                members: [
                    {
                        id: 'member-2',
                        displayName: 'Bob',
                        role: 'member',
                        status: 'active',
                        createdAt: '2026-01-01T00:00:00Z',
                        lastSeenAt: null,
                    },
                ],
                agents: Array.from({ length: 120 }, (_, index) => ({
                    source: `Agent ${String(index).padStart(3, '0')}`,
                    createdBy: index % 2 === 0 ? 'member-owner' : 'member-2',
                })),
            },
        });
        const page = ok(await client.agents.list({ limit: 100 }, signal()));
        expect(page.items).toHaveLength(100);
        expect(page.nextCursor).not.toBeNull();
        expect(new Set(page.items.map(({ createdBy }) => createdBy))).toEqual(new Set(['member-owner', 'member-2']));
        expect(ok(await client.members.list({}, signal())).items.map(({ displayName }) => displayName)).toEqual([
            'Bob',
            'Owner',
        ]);
    });

    it('refuses invalid seed data', () => {
        expect(() => createInMemoryEngineApiClient({ seed: { agents: [{ source: '' }] } })).toThrow();
        expect(() =>
            createInMemoryEngineApiClient({ seed: { folders: [{ id: 'f', name: 'x', extra: 1 } as never] } }),
        ).toThrow();
    });

    it('chains seeded audit entries and pages them newest first', async () => {
        const client = createInMemoryEngineApiClient({
            seed: {
                auditEntries: Array.from({ length: 230 }, (_, index) => ({
                    at: new Date(Date.parse('2026-10-01T00:00:00Z') + index * 60_000).toISOString(),
                    actor: { kind: 'system' as const },
                    action: 'engine.update.install' as const,
                    target: null,
                    outcome: 'success' as const,
                    client: null,
                })),
            },
        });
        const seqs: number[] = [];
        let cursor: string | undefined;
        do {
            const page = ok(await client.audit.list({ limit: 100, ...(cursor ? { cursor } : {}) }, signal()));
            seqs.push(...page.items.map(({ seq }) => seq));
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(seqs).toEqual(Array.from({ length: 230 }, (_, index) => 230 - index));
        expect(ok(await client.audit.verify(signal()))).toMatchObject({ status: 'intact', checkedEntries: 230 });
        const filtered = ok(
            await client.audit.list({ from: '2026-10-01T01:00:00Z', to: '2026-10-01T01:10:00Z' }, signal()),
        );
        expect(filtered.items.map(({ seq }) => seq)).toEqual([70, 69, 68, 67, 66, 65, 64, 63, 62, 61]);
    });

    it('ends a scripted failing reply with reply-failed', async () => {
        const client = createInMemoryEngineApiClient({
            replyScript: () => ({ chunks: ['partial'], outcome: 'failed' }),
        });
        const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
        const chat = ok(await client.chats.create(agent.id, {}, signal()));
        const sent = ok(await client.chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        const events = [];
        for await (const { event } of ok(await client.chats.streamReply(chat.id, sent.replyMessageId, {}, signal()))) {
            events.push(event.type === 'failed' ? event.problem.code : event.type);
        }
        expect(events).toEqual(['delta', 'reply-failed']);
    });
});

describe('verifyAuditChain', () => {
    it('finds the first entry that was edited or removed', async () => {
        const client = createInMemoryEngineApiClient();
        for (const name of ['A', 'B', 'C']) ok(await client.folders.create({ name }, signal()));
        const entries = AuditEntry.array().parse([...ok(await client.audit.list({}, signal())).items].reverse());
        const at = Timestamp.parse('2026-10-19T00:00:00Z');
        expect((await verifyAuditChain(entries, at)).status).toBe('intact');
        const edited = entries.map((entry) => (entry.seq === 2 ? { ...entry, outcome: 'failed' as const } : entry));
        expect(await verifyAuditChain(edited, at)).toMatchObject({ status: 'broken', firstBrokenSeq: 2 });
        const renamed = entries.map((entry) =>
            entry.seq === 2 && entry.target ? { ...entry, target: { ...entry.target, name: 'Z' } } : entry,
        );
        expect(await verifyAuditChain(renamed, at)).toMatchObject({ status: 'broken', firstBrokenSeq: 2 });
        const detailed = entries.map((entry) => (entry.seq === 3 ? { ...entry, details: { fields: [] } } : entry));
        expect(await verifyAuditChain(detailed, at)).toMatchObject({ status: 'broken', firstBrokenSeq: 3 });
        expect(
            await verifyAuditChain(
                [entries[0], entries[2]].filter((e) => e !== undefined),
                at,
            ),
        ).toMatchObject({
            status: 'broken',
            firstBrokenSeq: 3,
        });
    });
});

describe('paginate', () => {
    const spec = {
        name: 'lastUsed',
        key: (item: { id: string; used: number | null }) => item.used,
        descending: true,
        id: (item: { id: string }) => item.id,
    };

    it('sorts nulls last and keeps the position across inserts', () => {
        const items = [
            { id: 'a', used: null },
            { id: 'b', used: 3 },
            { id: 'c', used: 1 },
        ];
        const first = paginate(items, spec, { limit: 1 });
        if (first.kind !== 'page' || first.page.nextCursor === null) throw new Error('Expected a page');
        expect(first.page.items.map(({ id }) => id)).toEqual(['b']);
        const rest = paginate([{ id: 'd', used: 5 }, ...items], spec, { limit: 5, cursor: first.page.nextCursor });
        expect(rest.kind === 'page' && rest.page.items.map(({ id }) => id)).toEqual(['c', 'a']);
        expect(paginate(items, { ...spec, name: 'other' }, { limit: 1, cursor: first.page.nextCursor }).kind).toBe(
            'invalid-cursor',
        );
    });
});

describe('checkBook', () => {
    it('derives the profile and reports errors and warnings', () => {
        const book = checkBook('Ada\nMETA FULLNAME Ada Lovelace\nMETA COLOR #00aa00\nINITIAL MESSAGE Hi!\nFOO bar');
        expect(book.name).toBe('Ada');
        expect(book.profile).toMatchObject({ fullname: 'Ada Lovelace', color: '#00aa00', initialMessage: 'Hi!' });
        expect(book.diagnostics.map(({ severity, code }) => [severity, code])).toEqual([
            ['warning', 'unknown-commitment'],
        ]);
        expect(checkBook('Ada\nMETA COLOR red').diagnostics[0]).toMatchObject({
            severity: 'error',
            code: 'invalid-color',
            range: { startLine: 2 },
        });
    });
});
