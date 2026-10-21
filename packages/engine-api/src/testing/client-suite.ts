import { describe, expect, it } from 'vitest';

import type { EngineApiClient, EngineApiResponse } from '../client';
import { MAX_CHAT_PREVIEW_LENGTH } from '../constants';
import {
    AgentId,
    ChatId,
    FileId,
    FileVersionId,
    FolderId,
    IntegrationId,
    MemberId,
    MessageId,
    PasskeyId,
    RevisionId,
    RunId,
    SecretId,
    SessionId,
} from '../common';
import type { InMemoryEngine, InMemoryEngineApiOptions, InMemorySeed } from '../in-memory-client';
import { PERMISSIONS } from '../permissions';
import type { Permission } from '../permissions';
import type { EngineApiStreamItem } from '../route';

/** One second per reading, so ordering by time is deterministic and every write is visibly later. */
function steppingClock(start = Date.parse('2026-10-19T08:00:00Z')) {
    let tick = 0;
    return { now: () => new Date(start + 1000 * tick++) };
}

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

/** Builds a fresh engine for one test and acts as the member the options describe. */
export type MakeEngine = (options: InMemoryEngineApiOptions) => InMemoryEngine;

/**
 * The engine API's behaviour as engine-ui relies on it, against any engine the options can describe: the in-memory
 * client, the fetch client over the HTTP binding, or a real server serving a core (the mock engine). Call it inside a
 * `describe`.
 */
export function engineApiClientSuite(makeEngine: MakeEngine): void {
    const make = (options: InMemoryEngineApiOptions): EngineApiClient => makeEngine(options).client;
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
        expect(secret.valueUpdatedAt).toBe(secret.createdAt);
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
        const replaced = ok(await client.secrets.replaceValue(secret.id, { value: 'sk-new' }, signal()));
        expect(replaced.valueUpdatedAt).toBe(replaced.updatedAt);
        expect(replaced.updatedAt > secret.createdAt).toBe(true);
        const revoked = ok(await client.secrets.revoke(secret.id, signal()));
        expect(revoked).toMatchObject({ status: 'revoked', valueUpdatedAt: replaced.valueUpdatedAt });
        expect(revoked.updatedAt > replaced.updatedAt).toBe(true);
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
            details: { problem: 'forbidden', requiredPermission: 'agents.write' },
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
        const ids = (items: readonly { readonly id: string }[]) => items.map(({ id }) => id);

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

        it('summarises a chat: source, starter, message count, last message time and first user message', async () => {
            const client = make({ clock: steppingClock(), replyScript: () => ({ chunks: ['ok'] }) });
            const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
            const created = ok(await client.chats.create(agent.id, {}, signal()));
            expect(created).toMatchObject({
                title: '',
                source: 'web',
                createdBy: 'member-owner',
                messageCount: 0,
                lastMessageAt: null,
                preview: null,
            });
            const first = ok(
                await client.chats.sendMessage(created.id, { content: '  Review\n\n the   billing PR  ' }, signal()),
            );
            ok(await client.chats.sendMessage(created.id, { content: 'And the tests' }, signal()));
            const chat = ok(await client.chats.get(created.id, signal()));
            expect(chat).toMatchObject({ messageCount: 4, preview: 'Review the billing PR' });
            const newest = ok(await client.chats.listMessages(created.id, { limit: 1 }, signal())).items[0];
            expect(chat.lastMessageAt).toBe(newest?.createdAt);
            expect(Date.parse(chat.lastMessageAt ?? '')).toBeGreaterThan(Date.parse(first.userMessage.createdAt));
            expect(ok(await client.chats.list(agent.id, {}, signal())).items).toEqual([chat]);
        });

        it('cuts the preview to MAX_CHAT_PREVIEW_LENGTH, never inside a surrogate pair, and skips blank messages', async () => {
            const client = make({ clock: steppingClock(), replyScript: () => ({ chunks: ['ok'] }) });
            const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
            const blankFirst = ok(await client.chats.create(agent.id, {}, signal()));
            ok(await client.chats.sendMessage(blankFirst.id, { content: ' \n\t ' }, signal()));
            expect(ok(await client.chats.get(blankFirst.id, signal())).preview).toBeNull();
            ok(await client.chats.sendMessage(blankFirst.id, { content: 'Second try' }, signal()));
            expect(ok(await client.chats.get(blankFirst.id, signal())).preview).toBe('Second try');
            const long = ok(await client.chats.create(agent.id, {}, signal()));
            const text = `${'a'.repeat(MAX_CHAT_PREVIEW_LENGTH - 1)}\u{1F600}tail`;
            ok(await client.chats.sendMessage(long.id, { content: text }, signal()));
            expect(ok(await client.chats.get(long.id, signal())).preview).toBe('a'.repeat(MAX_CHAT_PREVIEW_LENGTH - 1));
            const exact = ok(await client.chats.create(agent.id, {}, signal()));
            ok(
                await client.chats.sendMessage(
                    exact.id,
                    { content: 'b'.repeat(MAX_CHAT_PREVIEW_LENGTH + 5) },
                    signal(),
                ),
            );
            expect(ok(await client.chats.get(exact.id, signal())).preview).toBe('b'.repeat(MAX_CHAT_PREVIEW_LENGTH));
        });

        it("lists visitors' chats with no member and filters chats by source", async () => {
            const { client, controller } = makeEngine({ clock: steppingClock() });
            const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
            const mine = ok(await client.chats.create(agent.id, { title: 'Mine' }, signal()));
            const visitor = controller.addVisitorChat({
                agentId: agent.id,
                messages: [
                    { role: 'user', content: 'Do you ship to Brno?' },
                    { role: 'agent', content: 'Yes, within two days.' },
                ],
            });
            const api = controller.addVisitorChat({ agentId: agent.id, source: 'api', title: 'Nightly sync' });
            expect(visitor).toMatchObject({
                source: 'web',
                createdBy: null,
                title: '',
                messageCount: 2,
                preview: 'Do you ship to Brno?',
            });
            expect(api).toMatchObject({ source: 'api', createdBy: null, messageCount: 0, preview: null });
            const visitorMessages = ok(await client.chats.listMessages(visitor.id, {}, signal())).items;
            expect(visitorMessages.map(({ role, createdBy, status }) => [role, createdBy, status])).toEqual([
                ['agent', null, 'completed'],
                ['user', null, 'completed'],
            ]);
            expect(visitor.lastMessageAt).toBe(visitorMessages[0]?.createdAt);
            expect(ids(ok(await client.chats.list(agent.id, {}, signal())).items)).toEqual([
                api.id,
                visitor.id,
                mine.id,
            ]);
            expect(ids(ok(await client.chats.list(agent.id, { source: 'api' }, signal())).items)).toEqual([api.id]);
            expect(ids(ok(await client.chats.listAll({ source: 'web' }, signal())).items)).toEqual([
                visitor.id,
                mine.id,
            ]);
            expect(ok(await client.chats.listAll({ source: 'email' }, signal())).items).toEqual([]);
            expect(problem(await client.chats.list(agent.id, { source: 'fax' as 'web' }, signal())).code).toBe(
                'validation-failed',
            );
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
        const metadata = ok(await client.files.upload({ file, name: 'hello.txt', purpose: 'upload' }, signal()));
        expect(metadata).toMatchObject({
            name: 'hello.txt',
            sizeBytes: 5,
            sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        });
        expect(await ok(await client.files.download(metadata.id, {}, signal())).text()).toBe('hello');
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
        expect(entries[1]?.target).toEqual({ kind: 'api-token', id: created.apiToken.id, name: 'CI' });
        expect(entries[1]?.details).toEqual({ fields: ['expiresAt', 'name', 'permissions'] });
        expect(entries[0]?.target).toEqual({ kind: 'api-token', id: created.apiToken.id, name: 'CI' });
        expect(entries[0]?.details).toBeNull();
        expect(entries[0]?.prevHash).toBe(entries[1]?.hash);
        expect(ok(await client.audit.verify(signal()))).toMatchObject({
            status: 'intact',
            checkedEntries: 2,
            lastSeq: 2,
        });
    });

    it("records the target's name as it was at each action, also after a rename and a delete", async () => {
        const client = owner();
        const folder = ok(await client.folders.create({ name: 'Drafts' }, signal()));
        ok(await client.folders.rename(folder.id, { name: '<img src=x onerror=alert(1)>' }, signal()));
        ok(await client.folders.delete(folder.id, signal()));
        const entries = ok(await client.audit.list({}, signal())).items;
        expect(entries.map(({ action, target }) => [action, target?.name])).toEqual([
            ['folder.delete', '<img src=x onerror=alert(1)>'],
            ['folder.rename', '<img src=x onerror=alert(1)>'],
            ['folder.create', 'Drafts'],
        ]);
        expect(entries[1]?.details).toEqual({ fields: ['name'] });
        expect(ok(await client.audit.verify(signal())).status).toBe('intact');
    });

    it('takes seeded audit entries with details and target names into the chain', async () => {
        const client = make({
            clock: steppingClock(),
            seed: {
                auditEntries: [
                    {
                        at: '2026-10-19T08:00:00Z',
                        actor: { kind: 'system' },
                        action: 'ui.update.install',
                        target: { kind: 'engine', id: 'engine', name: null },
                        outcome: 'success',
                        client: null,
                        details: { version: '1.4.0' },
                    },
                ],
            },
        });
        const [entry] = ok(await client.audit.list({}, signal())).items;
        expect(entry).toMatchObject({ seq: 1, details: { version: '1.4.0' }, target: { name: null } });
        expect(ok(await client.audit.verify(signal())).status).toBe('intact');
    });

    describe('own credentials under /me', () => {
        const at = '2026-10-19T08:00:00Z';
        const later = '2026-10-19T20:00:00Z';
        const session = (id: string, memberId: string, current = false, passkeyId: string | null = null) => ({
            id,
            memberId,
            current,
            client: null,
            passkeyId,
            createdAt: at,
            lastSeenAt: at,
            expiresAt: later,
        });
        const passkey = (id: string, memberId: string) => ({ id, memberId, name: id, createdAt: at, lastUsedAt: null });
        const credentialsOf = (permissions: readonly Permission[], stepUp: 'satisfied' | 'required' = 'satisfied') =>
            make({
                clock: steppingClock(),
                stepUp,
                member: { id: 'member-viewer', role: 'viewer', permissions },
                seed: {
                    members: [
                        {
                            id: 'member-other',
                            displayName: 'Other',
                            role: 'admin',
                            status: 'active',
                            createdAt: at,
                            lastSeenAt: null,
                        },
                    ],
                    sessions: [
                        session('session-here', 'member-viewer', true, 'passkey-b'),
                        session('session-laptop', 'member-viewer', false, 'passkey-a'),
                        session('session-phone', 'member-viewer'),
                        session('session-other', 'member-other', true),
                    ],
                    passkeys: [
                        passkey('passkey-a', 'member-viewer'),
                        passkey('passkey-b', 'member-viewer'),
                        passkey('passkey-other', 'member-other'),
                    ],
                },
            });
        const viewer = () => credentialsOf(['agents.read', 'chats.read', 'files.read', 'members.read']);
        const ids = (items: readonly { readonly id: string }[]) => items.map(({ id }) => id).sort();

        it("lets a viewer list and revoke their own sessions, and hides everyone else's", async () => {
            const client = viewer();
            expect(ids(ok(await client.me.listSessions({}, signal())).items)).toEqual([
                'session-here',
                'session-laptop',
                'session-phone',
            ]);
            expect(ok(await client.me.revokeSession(SessionId.parse('session-laptop'), signal()))).toBeNull();
            for (const id of ['session-other', 'session-laptop', 'session-unknown']) {
                expect(problem(await client.me.revokeSession(SessionId.parse(id), signal())), id).toMatchObject({
                    status: 404,
                    code: 'not-found',
                });
            }
            expect(problem(await client.sessions.list({}, signal()))).toMatchObject({
                status: 403,
                requiredPermission: 'security.read',
            });
            expect(problem(await client.sessions.revoke(SessionId.parse('session-other'), signal()))).toMatchObject({
                status: 403,
                requiredPermission: 'members.manage',
            });
        });

        it("lets a viewer revoke their own passkeys but never the last one, and hides everyone else's", async () => {
            const client = viewer();
            expect(ids(ok(await client.me.listPasskeys({}, signal())).items)).toEqual(['passkey-a', 'passkey-b']);
            for (const id of ['passkey-other', 'passkey-unknown']) {
                expect(problem(await client.me.revokePasskey(PasskeyId.parse(id), signal())), id).toMatchObject({
                    status: 404,
                    code: 'not-found',
                });
            }
            expect(ok(await client.me.revokePasskey(PasskeyId.parse('passkey-a'), signal()))).toBeNull();
            expect(problem(await client.me.revokePasskey(PasskeyId.parse('passkey-b'), signal()))).toMatchObject({
                status: 409,
                code: 'last-passkey',
            });
            expect(ids(ok(await client.me.listPasskeys({}, signal())).items)).toEqual(['passkey-b']);
        });

        it('names the passkey each session signed in with and ends those sessions when it is revoked', async () => {
            const client = viewer();
            const before = ok(await client.me.listSessions({}, signal())).items;
            expect(before.find(({ current }) => current)?.passkeyId).toBe('passkey-b');
            expect(before.find(({ id }) => id === 'session-laptop')?.passkeyId).toBe('passkey-a');
            expect(before.find(({ id }) => id === 'session-phone')?.passkeyId).toBeNull();
            ok(await client.me.revokePasskey(PasskeyId.parse('passkey-a'), signal()));
            expect(ids(ok(await client.me.listSessions({}, signal())).items)).toEqual([
                'session-here',
                'session-phone',
            ]);
        });

        it("counts every member's passkeys", async () => {
            const members = ok(await viewer().members.list({}, signal())).items;
            expect(Object.fromEntries(members.map(({ id, passkeyCount }) => [id, passkeyCount]))).toEqual({
                'member-other': 1,
                'member-viewer': 2,
            });
        });

        it('asks for step-up before revoking an own passkey', async () => {
            const client = credentialsOf(['agents.read'], 'required');
            expect(problem(await client.me.revokePasskey(PasskeyId.parse('passkey-a'), signal()))).toMatchObject({
                status: 401,
                code: 'step-up-required',
            });
            expect(ids(ok(await client.me.listPasskeys({}, signal())).items)).toEqual(['passkey-a', 'passkey-b']);
        });

        it('signs out everywhere else without touching other members', async () => {
            const client = credentialsOf(['security.read']);
            expect(ok(await client.me.revokeOtherSessions(signal()))).toEqual({ revoked: 2 });
            expect(ids(ok(await client.me.listSessions({}, signal())).items)).toEqual(['session-here']);
            expect(ids(ok(await client.sessions.list({}, signal())).items)).toEqual(['session-here', 'session-other']);
            expect(ok(await client.me.revokeOtherSessions(signal()))).toEqual({ revoked: 0 });
        });
    });

    it('lists members, passkeys and sessions, and keeps the last passkey', async () => {
        const client = owner();
        const members = ok(await client.members.list({}, signal())).items;
        expect(members.map(({ role, passkeyCount }) => [role, passkeyCount])).toEqual([['owner', 1]]);
        const [passkey] = ok(await client.passkeys.list({}, signal())).items;
        expect(passkey?.authenticator).toEqual({ attachment: 'platform', backedUp: true });
        if (passkey) expect(problem(await client.passkeys.revoke(passkey.id, signal())).code).toBe('last-passkey');
        expect(ok(await client.sessions.list({}, signal())).items[0]).toMatchObject({
            current: true,
            passkeyId: passkey?.id,
        });
    });

    it('reports every security panel field the engine sets, exactly as set', async () => {
        const at = '2026-10-19T08:00:00Z';
        const sha = 'e'.repeat(64);
        const engine = makeEngine({ clock: steppingClock() });
        const body = '{ "v":1,  "seq" :7}';
        const set = engine.controller.updateSecurity({
            engine: { version: '1.4.0', releaseLogIndex: 7, releaseLogEntryUuid: `${'1'.repeat(16)}${'2'.repeat(64)}` },
            ui: {
                version: '1.4.0',
                bundleSha256: sha,
                releaseLogIndex: 8,
                releaseLogEntryUuid: '3'.repeat(64),
                lastUpdateCheck: {
                    at,
                    outcome: 'refused',
                    version: '1.5.0',
                    reason: 'revocations-unverifiable',
                    revocationReason: 'expired',
                },
            },
            tls: {
                certificateSha256: sha,
                notAfter: at,
                lastCtCheck: {
                    at,
                    result: 'unexpected-certificate',
                    unexpectedCertificates: [
                        { sha256: 'f'.repeat(64), issuer: 'CN=Other CA', notBefore: at, notAfter: at },
                    ],
                },
            },
            relays: [{ hostname: 'relay-a.ptbk.test', status: 'disconnected', since: at, lastPingRttMs: 38 }],
            hostnames: [
                { hostname: 'engine.localhost', kind: 'default', certificateStatus: 'valid', claimRegistered: null },
                { hostname: 'ai.example.test', kind: 'custom', certificateStatus: 'expiring', claimRegistered: false },
            ],
            lastHeartbeat: { sentAt: at, body, signature: `ed25519=${'A'.repeat(86)}` },
            clockSkew: { seconds: -300, measuredAt: at },
            outboundDestinations: ['https://app.ptbk.io', 'https://api.openai.com'],
        });
        const read = ok(await engine.client.security.get(signal()));
        expect(read).toEqual(set);
        expect(read.lastHeartbeat?.body).toBe(body);
    });
    describe('capabilities', () => {
        const AT = '2026-10-19T08:00:00Z';
        const minutes = (n: number) => new Date(Date.parse(AT) + n * 60_000).toISOString();
        type SeedRun = NonNullable<InMemorySeed['runs']>[number];
        const runDetail = (id: string, fields: Partial<SeedRun>): SeedRun => ({
            id,
            agentId: 'agent-a',
            source: 'web',
            status: 'completed',
            chatId: null,
            messageId: null,
            triggerId: null,
            retryOf: null,
            createdBy: 'member-owner',
            queuedAt: AT,
            startedAt: null,
            completedAt: null,
            cancelRequestedAt: null,
            attemptCount: 1,
            runner: null,
            model: null,
            progress: null,
            usage: null,
            error: null,
            toolCalls: [],
            outputs: { messages: [], files: [], projectChanges: [] },
            report: { touchedProjects: [], externalSources: [] },
            ...fields,
        });
        const seed: InMemorySeed = {
            agents: [
                { id: 'agent-a', source: 'Ada' },
                { id: 'agent-b', source: 'Bob' },
            ],
            runs: [
                runDetail('run-1', { status: 'completed', queuedAt: minutes(-50), completedAt: minutes(-49) }),
                runDetail('run-2', {
                    status: 'failed',
                    source: 'schedule',
                    createdBy: null,
                    queuedAt: minutes(-40),
                    completedAt: minutes(-39),
                    error: { code: 'tool-error', summary: 'A tool failed.' },
                }),
                runDetail('run-3', {
                    status: 'running',
                    agentId: 'agent-b',
                    queuedAt: minutes(-30),
                    startedAt: minutes(-30),
                }),
                runDetail('run-4', { status: 'queued', source: 'api', queuedAt: minutes(-20), attemptCount: 0 }),
                runDetail('run-5', { status: 'queued', agentId: 'agent-b', queuedAt: minutes(-10), attemptCount: 0 }),
            ],
        };
        const engine = (options: InMemoryEngineApiOptions = {}) =>
            makeEngine({ clock: steppingClock(), seed, ...options });
        const ids = (items: readonly { readonly id: string }[]) => items.map(({ id }) => id);

        async function collectPages(
            fetchPage: (
                cursor: string | undefined,
            ) => Promise<{ items: readonly { readonly id: string }[]; nextCursor: string | null }>,
        ): Promise<string[]> {
            const all: string[] = [];
            let cursor: string | undefined;
            do {
                const next = await fetchPage(cursor);
                all.push(...ids(next.items));
                cursor = next.nextCursor ?? undefined;
            } while (cursor !== undefined);
            return all;
        }

        it('advertises all four capabilities by default and lists every chat across agents', async () => {
            const { client } = engine();
            const info = ok(await client.engine.get(signal()));
            expect(info.capabilities).toEqual([
                { id: 'runs', version: 1 },
                { id: 'files', version: 1 },
                { id: 'triggers', version: 1 },
                { id: 'integrations', version: 1 },
            ]);
            expect(info.engineId).toMatch(/^[a-z2-7]{26}$/);
            const first = ok(await client.chats.create(AgentId.parse('agent-a'), { title: 'Alpha' }, signal()));
            const second = ok(await client.chats.create(AgentId.parse('agent-b'), { title: 'Beta' }, signal()));
            expect(ids(ok(await client.chats.listAll({}, signal())).items)).toEqual([second.id, first.id]);
            expect(ids(ok(await client.chats.listAll({ agentId: AgentId.parse('agent-a') }, signal())).items)).toEqual([
                first.id,
            ]);
            expect(ids(ok(await client.chats.listAll({ q: 'bet' }, signal())).items)).toEqual([second.id]);
        });

        it('pages and filters runs, newest first by default', async () => {
            const { client } = engine();
            expect(
                await collectPages(async (cursor) =>
                    ok(await client.runs.list({ limit: 2, ...(cursor ? { cursor } : {}) }, signal())),
                ),
            ).toEqual(['run-5', 'run-4', 'run-3', 'run-2', 'run-1']);
            const list = async (query: Parameters<EngineApiClient['runs']['list']>[0]) =>
                ids(ok(await client.runs.list(query, signal())).items);
            expect(await list({ status: 'queued,running' })).toEqual(['run-5', 'run-4', 'run-3']);
            expect(await list({ agentId: AgentId.parse('agent-b'), sort: 'queuedAt' })).toEqual(['run-3', 'run-5']);
            expect(await list({ source: 'schedule' })).toEqual(['run-2']);
            expect(
                await list({ createdBy: MemberId.parse('member-owner'), from: minutes(-30), to: minutes(-10) }),
            ).toEqual(['run-4', 'run-3']);
            expect(problem(await client.runs.list({ status: 'queued,bogus' }, signal())).code).toBe(
                'validation-failed',
            );
            expect(ok(await client.runs.stats({}, signal()))).toEqual({
                running: 1,
                queued: 2,
                failedLast24h: 1,
                oldestQueuedAt: minutes(-20),
            });
            expect(ok(await client.runs.stats({ agentId: AgentId.parse('agent-b') }, signal()))).toMatchObject({
                queued: 1,
            });
            expect(ok(await client.runs.get(RunId.parse('run-2'), signal())).error?.code).toBe('tool-error');
            expect(problem(await client.runs.get(RunId.parse('nope'), signal())).code).toBe('not-found');
        });

        it('cancels idempotently and answers 409 once the run finished', async () => {
            const { client, controller } = engine();
            const runId = RunId.parse('run-3');
            const first = ok(await client.runs.cancel(runId, signal()));
            expect(first.status).toBe('running');
            expect(first.cancelRequestedAt).not.toBeNull();
            expect(ok(await client.runs.cancel(runId, signal()))).toEqual(first);
            expect(controller.advanceRun('run-3').status).toBe('cancelled');
            expect(problem(await client.runs.cancel(runId, signal()))).toMatchObject({
                status: 409,
                code: 'run-finished',
            });
            expect(problem(await client.runs.cancel(RunId.parse('run-1'), signal())).code).toBe('run-finished');
        });

        it('retries only failed runs', async () => {
            const { client } = engine();
            const retry = ok(await client.runs.retry(RunId.parse('run-2'), signal()));
            expect(retry).toMatchObject({
                status: 'queued',
                retryOf: 'run-2',
                source: 'schedule',
                createdBy: 'member-owner',
            });
            for (const id of ['run-1', 'run-3', 'run-4']) {
                expect(problem(await client.runs.retry(RunId.parse(id), signal())), id).toMatchObject({
                    status: 409,
                    code: 'run-not-retryable',
                });
            }
        });

        it('pages and filters files, serves versions and never serves an infected file', async () => {
            const { client } = engine({
                seed: {
                    ...seed,
                    files: [
                        {
                            metadata: {
                                id: 'file-bad',
                                name: 'bad.exe',
                                contentType: 'application/octet-stream',
                                sizeBytes: 2,
                                sha256: 'a'.repeat(64),
                                purpose: 'attachment',
                                agentId: 'agent-a',
                                chatId: null,
                                runId: null,
                                scan: { status: 'infected', checkedAt: AT },
                                createdBy: 'member-owner',
                                createdAt: minutes(-60),
                            },
                            content: new Blob(['MZ']),
                        },
                    ],
                },
            });
            const upload = async (name: string, purpose: 'knowledge' | 'upload', agentId?: string) =>
                ok(
                    await client.files.upload(
                        {
                            file: new Blob([name]),
                            name,
                            purpose,
                            ...(agentId ? { agentId: AgentId.parse(agentId) } : {}),
                        },
                        signal(),
                    ),
                );
            const notes = await upload('notes.md', 'knowledge', 'agent-a');
            const plan = await upload('plan.md', 'upload');
            const zeta = await upload('zeta.txt', 'knowledge', 'agent-b');
            expect(notes).toMatchObject({
                purpose: 'knowledge',
                agentId: 'agent-a',
                versionCount: 1,
                scan: { status: 'clean' },
            });
            expect(
                await collectPages(async (cursor) =>
                    ok(await client.files.list({ limit: 2, ...(cursor ? { cursor } : {}) }, signal())),
                ),
            ).toEqual([zeta.id, plan.id, notes.id, 'file-bad']);
            const list = async (query: Parameters<EngineApiClient['files']['list']>[0]) =>
                ids(ok(await client.files.list(query, signal())).items);
            expect(await list({ purpose: 'knowledge', sort: 'name' })).toEqual([notes.id, zeta.id]);
            expect(await list({ agentId: AgentId.parse('agent-a'), sort: '-sizeBytes' })).toEqual([
                notes.id,
                'file-bad',
            ]);
            expect(await list({ scan: 'infected' })).toEqual(['file-bad']);
            expect(await list({ q: 'PLAN' })).toEqual([plan.id]);
            expect(ok(await client.files.get(plan.id, signal()))).toEqual(plan);
            const [version] = ok(await client.files.listVersions(plan.id, {}, signal())).items;
            expect(version).toMatchObject({ sizeBytes: plan.sizeBytes, sha256: plan.sha256, commitHash: null });
            if (version) {
                expect(await ok(await client.files.download(plan.id, { version: version.id }, signal())).text()).toBe(
                    'plan.md',
                );
            }
            expect(
                problem(await client.files.download(plan.id, { version: FileVersionId.parse('nope') }, signal())).code,
            ).toBe('not-found');
            expect(problem(await client.files.download(FileId.parse('file-bad'), {}, signal()))).toMatchObject({
                status: 409,
                code: 'file-infected',
            });
            expect(problem(await client.files.get(FileId.parse('nope'), signal())).code).toBe('not-found');
        });

        it('creates triggers, pages and filters them, and refuses invalid schedules with 422', async () => {
            const { client } = engine();
            const agentId = AgentId.parse('agent-a');
            const schedule = ok(
                await client.triggers.create(
                    {
                        kind: 'schedule',
                        agentId,
                        name: 'Hourly',
                        recurrence: { kind: 'interval', everySeconds: 3600 },
                        message: 'Check the inbox.',
                    },
                    signal(),
                ),
            );
            expect(schedule).toMatchObject({ kind: 'schedule', lifecycle: 'active', config: { runCount: 0 } });
            expect(schedule.nextFireAt).not.toBeNull();
            const email = ok(await client.triggers.create({ kind: 'email', agentId, name: 'Inbox' }, signal()));
            expect(email.kind === 'email' && email.config.address).toMatch(/@engine\.localhost$/);
            const cron = ok(
                await client.triggers.create(
                    {
                        kind: 'schedule',
                        agentId: AgentId.parse('agent-b'),
                        name: 'Weekdays',
                        recurrence: { kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Europe/Prague' },
                        message: 'Morning summary.',
                    },
                    signal(),
                ),
            );
            expect(
                await collectPages(async (cursor) =>
                    ok(await client.triggers.list({ limit: 2, ...(cursor ? { cursor } : {}) }, signal())),
                ),
            ).toEqual([cron.id, email.id, schedule.id]);
            expect(ids(ok(await client.triggers.list({ kind: 'email' }, signal())).items)).toEqual([email.id]);
            expect(ids(ok(await client.triggers.list({ agentId: AgentId.parse('agent-b') }, signal())).items)).toEqual([
                cron.id,
            ]);
            expect(ok(await client.triggers.get(email.id, signal()))).toEqual(email);

            const refused = async (
                recurrence: Parameters<EngineApiClient['triggers']['create']>[0],
                what: string,
            ): Promise<void> => {
                expect(problem(await client.triggers.create(recurrence, signal())), what).toMatchObject({
                    status: 422,
                    code: 'invalid-schedule',
                });
            };
            const base = { kind: 'schedule', agentId, name: 'Bad', message: 'x' } as const;
            await refused({ ...base, recurrence: { kind: 'cron', expression: '61 * * * *', timeZone: 'UTC' } }, 'cron');
            await refused(
                { ...base, recurrence: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Mars/Olympus' } },
                'time zone',
            );
            await refused(
                {
                    ...base,
                    recurrence: { kind: 'interval', everySeconds: 600 },
                    startsAt: minutes(60),
                    endsAt: minutes(30),
                },
                'range',
            );
            expect(
                problem(
                    await client.triggers.update(
                        schedule.id,
                        { recurrence: { kind: 'cron', expression: 'every day', timeZone: 'UTC' } },
                        signal(),
                    ),
                ).code,
            ).toBe('invalid-schedule');
            const renamed = ok(
                await client.triggers.update(schedule.id, { name: 'Every hour', message: 'Hi' }, signal()),
            );
            expect(renamed).toMatchObject({ name: 'Every hour', config: { message: 'Hi' } });
        });

        it('pauses and resumes idempotently and refuses to touch an ended trigger', async () => {
            const { client, controller } = engine();
            const trigger = ok(
                await client.triggers.create(
                    {
                        kind: 'schedule',
                        agentId: AgentId.parse('agent-a'),
                        name: 'Once more',
                        recurrence: { kind: 'interval', everySeconds: 60 },
                        maxRunCount: 1,
                        message: 'Go.',
                    },
                    signal(),
                ),
            );
            const paused = ok(await client.triggers.pause(trigger.id, signal()));
            expect(paused).toMatchObject({ lifecycle: 'paused', nextFireAt: null });
            expect(ok(await client.triggers.pause(trigger.id, signal()))).toEqual(paused);
            const resumed = ok(await client.triggers.resume(trigger.id, signal()));
            expect(resumed.lifecycle).toBe('active');
            expect(ok(await client.triggers.resume(trigger.id, signal()))).toEqual(resumed);

            const fire = controller.fireTrigger(trigger.id);
            expect(fire.outcome).toBe('started');
            expect(fire.runId).not.toBeNull();
            const ended = ok(await client.triggers.get(trigger.id, signal()));
            expect(ended).toMatchObject({ lifecycle: 'ended', endedReason: 'max-runs', nextFireAt: null });
            for (const response of [
                await client.triggers.resume(trigger.id, signal()),
                await client.triggers.pause(trigger.id, signal()),
            ]) {
                expect(problem(response)).toMatchObject({
                    status: 409,
                    code: 'trigger-ended',
                });
            }
            expect(problem(await client.triggers.update(trigger.id, { name: 'x' }, signal())).code).toBe(
                'trigger-ended',
            );
            const fires = ok(await client.triggers.listFires(trigger.id, {}, signal())).items;
            expect(fires).toEqual([fire]);
            expect(ok(await client.runs.list({ triggerId: trigger.id }, signal())).items[0]).toMatchObject({
                id: fire.runId,
                source: 'schedule',
                createdBy: null,
            });
            expect(ok(await client.triggers.delete(trigger.id, signal()))).toBeNull();
            expect(problem(await client.triggers.get(trigger.id, signal())).code).toBe('not-found');
        });

        it('connects integrations by secret name, pages and filters them, and enables and disables them', async () => {
            const { client } = engine();
            ok(
                await client.secrets.create(
                    { name: 'GITHUB_TOKEN', scope: { kind: 'engine' }, value: 'ghp_x' },
                    signal(),
                ),
            );
            const repo = ok(
                await client.integrations.create(
                    {
                        kind: 'repository',
                        name: 'Billing',
                        agentId: AgentId.parse('agent-a'),
                        provider: 'github',
                        repository: 'acme/billing',
                        secretNames: ['GITHUB_TOKEN'],
                    },
                    signal(),
                ),
            );
            expect(repo).toMatchObject({
                status: 'connected',
                secretRefs: [{ name: 'GITHUB_TOKEN', state: 'resolved' }],
            });
            expect(JSON.stringify(repo)).not.toContain('ghp_x');
            const mcp = ok(
                await client.integrations.create(
                    {
                        kind: 'mcp-server',
                        name: 'Docs',
                        url: 'https://docs.example.com/mcp',
                        secretNames: ['DOCS_KEY'],
                    },
                    signal(),
                ),
            );
            expect(mcp).toMatchObject({ status: 'needs-attention', agentId: null, secretRefs: [{ state: 'missing' }] });
            const third = ok(
                await client.integrations.create(
                    { kind: 'mcp-server', name: 'Search', url: 'https://search.example.com/mcp' },
                    signal(),
                ),
            );
            expect(
                await collectPages(async (cursor) =>
                    ok(await client.integrations.list({ limit: 2, ...(cursor ? { cursor } : {}) }, signal())),
                ),
            ).toEqual([third.id, mcp.id, repo.id]);
            expect(ids(ok(await client.integrations.list({ kind: 'repository' }, signal())).items)).toEqual([repo.id]);
            expect(ids(ok(await client.integrations.list({ status: 'needs-attention' }, signal())).items)).toEqual([
                mcp.id,
            ]);
            const disabled = ok(await client.integrations.disable(repo.id, signal()));
            expect(disabled.status).toBe('disconnected');
            expect(ok(await client.integrations.disable(repo.id, signal()))).toEqual(disabled);
            expect(ok(await client.integrations.enable(repo.id, signal())).status).toBe('connected');
            ok(await client.secrets.create({ name: 'DOCS_KEY', scope: { kind: 'engine' }, value: 'k' }, signal()));
            expect(ok(await client.integrations.check(mcp.id, signal())).status).toBe('connected');
            expect(ok(await client.integrations.update(mcp.id, { name: 'Docs search' }, signal())).name).toBe(
                'Docs search',
            );
            expect(ok(await client.integrations.get(mcp.id, signal())).kind).toBe('mcp-server');
            expect(ok(await client.integrations.delete(mcp.id, signal()))).toBeNull();
            expect(problem(await client.integrations.get(mcp.id, signal())).code).toBe('not-found');
        });

        it('pages and filters activity, newest first', async () => {
            const { client, controller } = engine();
            controller.advanceRun('run-4');
            controller.advanceRun('run-4', { status: 'failed', error: { code: 'boom', summary: 'Broke.' } });
            ok(await client.files.upload({ file: new Blob(['x']), name: 'x.txt', purpose: 'upload' }, signal()));
            controller.appendActivity({
                kind: 'member.joined',
                agentId: null,
                actor: { kind: 'system' },
                memberId: 'member-new',
                displayName: 'New',
            });
            const all = ok(await client.activity.list({}, signal()));
            expect(all.dropped).toBe(0);
            const kinds = all.items.map((item) => (item.kind === 'known' ? item.activity.kind : item.kind));
            expect(kinds).toEqual(['member.joined', 'file.created', 'run.failed', 'run.started']);
            const pages: string[] = [];
            let cursor: string | undefined;
            do {
                const next = ok(await client.activity.list({ limit: 3, ...(cursor ? { cursor } : {}) }, signal()));
                for (const item of next.items) if (item.kind === 'known') pages.push(item.activity.kind);
                cursor = next.nextCursor ?? undefined;
            } while (cursor !== undefined);
            expect(pages).toEqual(kinds);
            const list = async (query: Parameters<EngineApiClient['activity']['list']>[0]) =>
                ok(await client.activity.list(query, signal())).items.map((item) =>
                    item.kind === 'known' ? item.activity.kind : item.kind,
                );
            expect(await list({ kind: 'run.' })).toEqual(['run.failed', 'run.started']);
            expect(await list({ kind: 'run.failed' })).toEqual(['run.failed']);
            expect(await list({ runId: RunId.parse('run-4') })).toEqual(['run.failed', 'run.started']);
            expect(await list({ agentId: AgentId.parse('agent-b') })).toEqual([]);
        });

        it('hides runs, run activity and run events from a member without runs.read', async () => {
            const { client, controller } = engine({
                member: {
                    id: 'member-limited',
                    role: 'member',
                    permissions: PERMISSIONS.filter((permission) => permission !== 'runs.read'),
                },
            });
            expect(problem(await client.runs.list({}, signal()))).toMatchObject({
                status: 403,
                code: 'forbidden',
                requiredPermission: 'runs.read',
            });
            expect(problem(await client.runs.get(RunId.parse('run-1'), signal())).code).toBe('forbidden');
            expect(problem(await client.runs.stats({}, signal())).code).toBe('forbidden');
            const controller2 = new AbortController();
            const iterator = ok(await client.events.stream({}, controller2.signal))[Symbol.asyncIterator]();
            const next = iterator.next();
            controller.advanceRun('run-4');
            controller.emit({ type: 'agent.changed', agentId: 'agent-a' });
            const delivered = await next;
            expect(delivered.done ? undefined : delivered.value.event).toEqual({
                type: 'agent.changed',
                agentId: 'agent-a',
            });
            controller2.abort();
            await iterator.return?.();
            ok(await client.files.upload({ file: new Blob(['x']), name: 'x.txt', purpose: 'upload' }, signal()));
            const kinds = ok(await client.activity.list({}, signal())).items.map((item) =>
                item.kind === 'known' ? item.activity.kind : item.kind,
            );
            expect(kinds).toEqual(['file.created']);
        });

        it('answers 404 capability-not-supported for every route of a capability the engine does not advertise', async () => {
            const { client } = engine({ capabilities: [{ id: 'files', version: 1 }] });
            expect(ok(await client.engine.get(signal())).capabilities).toEqual([{ id: 'files', version: 1 }]);
            const unsupported = [
                await client.runs.list({}, signal()),
                await client.runs.cancel(RunId.parse('run-1'), signal()),
                await client.triggers.list({}, signal()),
                await client.triggers.create({ kind: 'email', agentId: AgentId.parse('agent-a'), name: 'x' }, signal()),
                await client.integrations.list({}, signal()),
                await client.integrations.check(IntegrationId.parse('nope'), signal()),
            ];
            for (const response of unsupported) {
                expect(problem(response)).toMatchObject({ status: 404, code: 'capability-not-supported' });
            }
            expect(ok(await client.files.list({}, signal())).items).toEqual([]);
            expect(ok(await client.activity.list({}, signal())).items).toEqual([]);
        });
    });
}
