import { describe, expect, it } from 'vitest';

import type { EngineApiClient, EngineApiResponse } from './client';
import { AgentId, ChatId, FolderId, MessageId, RevisionId, SecretId } from './common';
import { ENGINE_API_PREFIX } from './constants';
import { createFetchEngineApiClient } from './fetch-client';
import { createInMemoryEngineApiClient, createInMemoryEngineApiTransport } from './in-memory-client';
import type { InMemoryEngineApiOptions } from './in-memory-client';
import { PERMISSIONS } from './permissions';
import type { EngineApiStreamItem } from './route';
import { createInProcessHandler } from './testing/in-process-handler';

/** One second per reading, so ordering by time is deterministic and every write is visibly later. */
function steppingClock(start = Date.parse('2026-10-19T08:00:00Z')) {
    let tick = 0;
    return { now: () => new Date(start + 1000 * tick++) };
}

const VARIANTS: readonly [string, (options: InMemoryEngineApiOptions) => EngineApiClient][] = [
    ['in-memory client', (options) => createInMemoryEngineApiClient(options)],
    [
        'fetch client over the in-memory engine',
        (options) => {
            const handler = createInProcessHandler(createInMemoryEngineApiTransport(options));
            return createFetchEngineApiClient({
                baseUrl: 'https://engine.test',
                fetch: (input, init) => handler(new Request(input, init)),
                timeoutMs: 5_000,
            });
        },
    ],
];

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function problem(response: EngineApiResponse<unknown>) {
    if (response.kind !== 'problem') throw new Error('Expected a problem');
    return response.problem;
}

async function collect<T>(items: AsyncIterable<EngineApiStreamItem<T>>): Promise<EngineApiStreamItem<T>[]> {
    const collected: EngineApiStreamItem<T>[] = [];
    for await (const item of items) collected.push(item);
    return collected;
}

const signal = () => AbortSignal.timeout(5_000);

describe.each(VARIANTS)('%s', (_, make) => {
    const owner = () => make({ clock: steppingClock() });

    it('reports the member with every permission and the engine', async () => {
        const client = owner();
        const me = ok(await client.me.get(signal()));
        expect(me.role).toBe('owner');
        expect([...me.permissions].sort()).toEqual([...PERMISSIONS].sort());
        expect(ok(await client.engine.get(signal())).mode).toBe('local');
    });

    it('creates, reads and lists an agent derived from its book', async () => {
        const client = owner();
        const agent = ok(await client.agents.create({ source: 'Ada\nPERSONA A careful reviewer' }, signal()));
        expect(agent).toMatchObject({ name: 'Ada', profile: { description: 'A careful reviewer' }, deletedAt: null });
        expect(ok(await client.agents.get(agent.id, signal()))).toEqual(agent);
        expect(ok(await client.agents.list({}, signal())).items).toEqual([agent]);
        expect(ok(await client.agents.getSource(agent.id, signal())).source).toBe('Ada\nPERSONA A careful reviewer');
    });

    it('refuses a book with an error diagnostic and stores nothing', async () => {
        const client = owner();
        const refused = problem(await client.agents.create({ source: '  \n' }, signal()));
        expect(refused).toMatchObject({ status: 422, code: 'invalid-book' });
        expect(refused.diagnostics?.[0]).toMatchObject({ severity: 'error', code: 'empty-book' });
        expect(ok(await client.agents.list({}, signal())).items).toEqual([]);
        expect(ok(await client.agents.validate({ source: 'Ada\nWHATEVER x' }, signal()))[0]).toMatchObject({
            severity: 'warning',
        });
    });

    it('rejects unknown fields and invalid parameters with validation-failed', async () => {
        const client = owner();
        const extra = problem(await client.agents.create({ source: 'Ada', admin: true } as never, signal()));
        expect(extra).toMatchObject({ status: 400, code: 'validation-failed' });
        expect(extra.errors?.map(({ path }) => path)).toEqual(['body']);
        expect(problem(await client.agents.list({ limit: 0 }, signal())).errors?.[0]?.path).toBe('query.limit');
        expect(problem(await client.agents.list({ sort: 'size' } as never, signal())).code).toBe('validation-failed');
        expect(problem(await client.agents.get(AgentId.parse('missing'), signal())).code).toBe('not-found');
    });

    it('pages with stable cursors, unaffected by inserts', async () => {
        const client = owner();
        for (const name of ['Bea', 'Cid', 'Dot', 'Eve', 'Fay']) {
            ok(await client.agents.create({ source: name }, signal()));
        }
        const first = ok(await client.agents.list({ limit: 2 }, signal()));
        expect(first.items.map(({ name }) => name)).toEqual(['Bea', 'Cid']);
        ok(await client.agents.create({ source: 'Abe' }, signal()));
        const names: string[] = first.items.map(({ name }) => name);
        let cursor = first.nextCursor;
        while (cursor !== null) {
            const next = ok(await client.agents.list({ limit: 2, cursor }, signal()));
            names.push(...next.items.map(({ name }) => name));
            cursor = next.nextCursor;
        }
        expect(names).toEqual(['Bea', 'Cid', 'Dot', 'Eve', 'Fay']);
        const sortedOther = ok(await client.agents.list({ limit: 2, sort: '-name' }, signal()));
        expect(
            problem(await client.agents.list({ cursor: first.nextCursor ?? '', sort: '-name' }, signal())).code,
        ).toBe('invalid-cursor');
        expect(sortedOther.items.map(({ name }) => name)).toEqual(['Fay', 'Eve']);
        expect(problem(await client.agents.list({ cursor: 'garbage' }, signal()))).toMatchObject({
            status: 400,
            code: 'invalid-cursor',
        });
    });

    it('soft-deletes and restores agents', async () => {
        const client = owner();
        const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
        const deleted = ok(await client.agents.delete(agent.id, signal()));
        expect(deleted.deletedAt).not.toBeNull();
        expect(ok(await client.agents.list({}, signal())).items).toEqual([]);
        expect(ok(await client.agents.list({ deleted: 'only' }, signal())).items).toEqual([deleted]);
        expect(problem(await client.agents.update(agent.id, { visibility: 'public' }, signal())).code).toBe(
            'agent-deleted',
        );
        expect(ok(await client.agents.restore(agent.id, signal())).deletedAt).toBeNull();
        expect(ok(await client.agents.list({}, signal())).items).toHaveLength(1);
    });

    it('detects revision conflicts and keeps history', async () => {
        const client = owner();
        const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
        const saved = ok(
            await client.agents.updateSource(
                agent.id,
                { source: 'Ada\nPERSONA v2', baseRevisionId: agent.currentRevisionId },
                signal(),
            ),
        );
        expect(saved.revisionId).not.toBe(agent.currentRevisionId);
        const stale = problem(
            await client.agents.updateSource(
                agent.id,
                { source: 'Ada\nPERSONA v3', baseRevisionId: agent.currentRevisionId },
                signal(),
            ),
        );
        expect(stale).toMatchObject({ status: 409, code: 'revision-conflict' });
        const revisions = ok(await client.agents.listRevisions(agent.id, {}, signal())).items;
        expect(revisions.map(({ id }) => id)).toEqual([saved.revisionId, agent.currentRevisionId]);
        expect(ok(await client.agents.getRevision(agent.id, agent.currentRevisionId, signal())).source).toBe('Ada');
        expect(problem(await client.agents.getRevision(agent.id, RevisionId.parse('nope'), signal())).code).toBe(
            'not-found',
        );
        expect(ok(await client.agents.get(agent.id, signal())).profile.description).toBe('v2');
    });

    it('stores secrets without ever returning their values', async () => {
        const client = owner();
        const secret = ok(
            await client.secrets.create(
                { name: 'OPENAI_API_KEY', scope: { kind: 'engine' }, value: 'sk-super-secret' },
                signal(),
            ),
        );
        expect(JSON.stringify(secret)).not.toContain('sk-super-secret');
        expect(secret).not.toHaveProperty('value');
        expect(
            problem(
                await client.secrets.create(
                    { name: 'OPENAI_API_KEY', scope: { kind: 'engine' }, value: 'x' },
                    signal(),
                ),
            ).code,
        ).toBe('name-taken');
        const listed = ok(await client.secrets.list({ scope: 'engine' }, signal()));
        expect(JSON.stringify(listed)).not.toContain('sk-super-secret');
        ok(await client.secrets.replaceValue(secret.id, { value: 'sk-new' }, signal()));
        expect(ok(await client.secrets.revoke(secret.id, signal())).status).toBe('revoked');
        expect(problem(await client.secrets.replaceValue(secret.id, { value: 'x' }, signal())).code).toBe(
            'secret-revoked',
        );
        expect(ok(await client.secrets.delete(secret.id, signal()))).toBeNull();
        expect(problem(await client.secrets.revoke(SecretId.parse(secret.id), signal())).code).toBe('not-found');
    });

    it('answers 403 with the required permission and audits the denial', async () => {
        const client = make({
            clock: steppingClock(),
            member: {
                id: 'member-limited',
                role: 'member',
                permissions: PERMISSIONS.filter((p) => p !== 'agents.write'),
            },
        });
        const denied = problem(await client.agents.create({ source: 'Ada' }, signal()));
        expect(denied).toMatchObject({ status: 403, code: 'forbidden', requiredPermission: 'agents.write' });
        const audit = ok(await client.audit.list({ outcome: 'denied' }, signal())).items;
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
            action: 'agent.create',
            outcome: 'denied',
            actor: { kind: 'member', memberId: 'member-limited' },
        });
        expect(ok(await client.agents.list({}, signal())).items).toEqual([]);
    });

    it('asks for step-up on step-up routes when the gateway requires it', async () => {
        const client = make({ clock: steppingClock(), stepUp: 'required' });
        expect(problem(await client.settings.setUpdatePolicy({ policy: 'manual' }, signal()))).toMatchObject({
            status: 401,
            code: 'step-up-required',
        });
        expect(ok(await client.settings.update({ name: 'Renamed' }, signal())).name).toBe('Renamed');
    });

    it('sets the update policy with a version exactly when pinned', async () => {
        const client = owner();
        expect(problem(await client.settings.setUpdatePolicy({ policy: 'pinned' } as never, signal())).code).toBe(
            'validation-failed',
        );
        expect(
            ok(await client.settings.setUpdatePolicy({ policy: 'pinned', pinnedVersion: '1.8.2' }, signal())),
        ).toEqual({
            policy: 'pinned',
            pinnedVersion: '1.8.2',
        });
        expect(ok(await client.security.get(signal())).update).toMatchObject({
            policy: 'pinned',
            pinnedVersion: '1.8.2',
        });
    });

    describe('chat', () => {
        async function startChat(client: EngineApiClient) {
            const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
            const chat = ok(await client.chats.create(agent.id, { title: 'Hello' }, signal()));
            const sent = ok(await client.chats.sendMessage(chat.id, { content: 'hi there' }, signal()));
            return { chat, sent };
        }

        it('streams a reply to completion, then refuses to cancel it', async () => {
            const client = make({ clock: steppingClock(), replyScript: () => ({ chunks: ['Hel', 'lo'] }) });
            const { chat, sent } = await startChat(client);
            expect(sent.userMessage).toMatchObject({ role: 'user', content: 'hi there', status: 'completed' });
            const stream = ok(await client.chats.streamReply(chat.id, sent.replyMessageId, {}, signal()));
            const items = await collect(stream);
            expect(items.map(({ id, event }) => [id, event.type])).toEqual([
                ['1', 'delta'],
                ['2', 'delta'],
                ['2', 'completed'],
            ]);
            expect(items.at(-1)?.event).toMatchObject({ type: 'completed', message: { content: 'Hello' } });
            const messages = ok(await client.chats.listMessages(chat.id, {}, signal())).items;
            expect(messages.map(({ role, status }) => [role, status])).toEqual([
                ['agent', 'completed'],
                ['user', 'completed'],
            ]);
            expect(problem(await client.chats.cancelReply(chat.id, sent.replyMessageId, signal()))).toMatchObject({
                status: 409,
                code: 'reply-finished',
            });
        });

        it('resumes a reply stream after Last-Event-ID', async () => {
            const client = make({ clock: steppingClock(), replyScript: () => ({ chunks: ['a', 'b', 'c'] }) });
            const { chat, sent } = await startChat(client);
            const items = await collect(
                ok(await client.chats.streamReply(chat.id, sent.replyMessageId, { lastEventId: '2' }, signal())),
            );
            expect(items.map(({ event }) => event)).toEqual([
                { type: 'delta', seq: 3, text: 'c' },
                expect.objectContaining({ type: 'completed' }),
            ]);
        });

        it('ends a cancelled reply with failed/cancelled, idempotently', async () => {
            const client = owner();
            const { chat, sent } = await startChat(client);
            expect(ok(await client.chats.cancelReply(chat.id, sent.replyMessageId, signal())).status).toBe('cancelled');
            expect(ok(await client.chats.cancelReply(chat.id, sent.replyMessageId, signal())).status).toBe('cancelled');
            const items = await collect(ok(await client.chats.streamReply(chat.id, sent.replyMessageId, {}, signal())));
            expect(items.map(({ event }) => (event.type === 'failed' ? event.problem.code : event.type))).toEqual([
                'cancelled',
            ]);
            expect(problem(await client.chats.streamReply(chat.id, MessageId.parse('nope'), {}, signal())).code).toBe(
                'not-found',
            );
            expect(problem(await client.chats.get(ChatId.parse('nope'), signal())).code).toBe('not-found');
        });
    });

    it('streams engine events and stops on abort', async () => {
        const client = owner();
        const controller = new AbortController();
        const stream = ok(await client.events.stream({}, controller.signal));
        const iterator = stream[Symbol.asyncIterator]();
        const first = iterator.next();
        const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
        expect((await first).value).toEqual({ id: '1', event: { type: 'agent.changed', agentId: agent.id } });
        const pending = iterator.next();
        controller.abort();
        await expect(pending).rejects.toThrow();
    });

    it('resumes engine events after Last-Event-ID', async () => {
        const client = owner();
        const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
        ok(await client.agents.start(agent.id, signal()));
        const controller = new AbortController();
        const iterator = ok(await client.events.stream({ lastEventId: '1' }, controller.signal))[
            Symbol.asyncIterator
        ]();
        expect((await iterator.next()).value).toMatchObject({
            id: '2',
            event: { type: 'agent.status', agentId: agent.id, state: 'running' },
        });
        controller.abort();
        await iterator.return?.();
    });

    it('keeps folders that still hold agents', async () => {
        const client = owner();
        const folder = ok(await client.folders.create({ name: 'Team' }, signal()));
        expect(problem(await client.folders.create({ name: 'team' }, signal())).code).toBe('name-taken');
        const agent = ok(await client.agents.create({ source: 'Ada', folderId: folder.id }, signal()));
        expect(problem(await client.folders.delete(folder.id, signal())).code).toBe('folder-not-empty');
        ok(await client.agents.update(agent.id, { folderId: null }, signal()));
        expect(ok(await client.folders.delete(folder.id, signal()))).toBeNull();
        expect(problem(await client.folders.delete(FolderId.parse(folder.id), signal())).code).toBe('not-found');
    });

    it('uploads and downloads files', async () => {
        const client = owner();
        const file = new Blob(['hello'], { type: 'text/plain' });
        const metadata = ok(await client.files.upload({ file, name: 'hello.txt' }, signal()));
        expect(metadata).toMatchObject({
            name: 'hello.txt',
            sizeBytes: 5,
            sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        });
        expect(await ok(await client.files.download(metadata.id, signal())).text()).toBe('hello');
        expect(ok(await client.files.list({}, signal())).items).toEqual([metadata]);
        expect(ok(await client.files.delete(metadata.id, signal()))).toBeNull();
    });

    it('returns an API token once and keeps an intact audit chain', async () => {
        const client = owner();
        const created = ok(
            await client.apiTokens.create(
                { name: 'CI', permissions: ['agents.read'], expiresAt: '2027-01-01T00:00:00Z' },
                signal(),
            ),
        );
        expect(created.token.length).toBeGreaterThanOrEqual(16);
        expect(JSON.stringify(ok(await client.apiTokens.list({}, signal())))).not.toContain(created.token);
        expect(ok(await client.apiTokens.revoke(created.apiToken.id, signal())).status).toBe('revoked');
        const entries = ok(await client.audit.list({}, signal())).items;
        expect(entries.map(({ action }) => action)).toEqual(['api-token.revoke', 'api-token.create']);
        expect(entries[1]?.target).toEqual({ kind: 'api-token', id: created.apiToken.id });
        expect(entries[0]?.prevHash).toBe(entries[1]?.hash);
        expect(ok(await client.audit.verify(signal()))).toMatchObject({
            status: 'intact',
            checkedEntries: 2,
            lastSeq: 2,
        });
    });

    it('lists members, passkeys and sessions, and keeps the last passkey', async () => {
        const client = owner();
        const members = ok(await client.members.list({}, signal())).items;
        expect(members.map(({ role }) => role)).toEqual(['owner']);
        const [passkey] = ok(await client.passkeys.list({}, signal())).items;
        expect(passkey).toBeDefined();
        if (passkey) expect(problem(await client.passkeys.revoke(passkey.id, signal())).code).toBe('last-passkey');
        expect(ok(await client.sessions.list({}, signal())).items[0]?.current).toBe(true);
    });
});

describe('fetch client wiring', () => {
    it('calls only the versioned API prefix', async () => {
        const urls: string[] = [];
        const handler = createInProcessHandler(createInMemoryEngineApiTransport());
        const client = createFetchEngineApiClient({
            baseUrl: 'https://engine.test',
            fetch: (input, init) => {
                const request = new Request(input, init);
                urls.push(new URL(request.url).pathname);
                return handler(request);
            },
            timeoutMs: 1_000,
        });
        ok(await client.agents.list({}, signal()));
        expect(urls).toEqual([`${ENGINE_API_PREFIX}/agents`]);
    });
});
