import { describe, expect, it } from 'vitest';

import type { EngineApiClient, EngineApiResponse } from '../client';
import {
    AgentId,
    ApiTokenId,
    ChatId,
    FileId,
    FolderId,
    InviteId,
    MemberId,
    MessageId,
    PasskeyId,
    SessionId,
} from '../common';
import { WalletRecordId } from '../capabilities/wallet';
import { MAX_FILE_BYTES } from '../constants';
import { createInMemoryEngine, createInMemoryEngineApiClient } from '../in-memory-client';
import { createInMemoryEngineApiTransport } from '../testing/in-memory-transport';
import type { InMemoryEngineApiOptions } from '../in-memory-client';
import { PERMISSIONS } from '../permissions';
import { ENGINE_API_ROUTES } from '../routes';

const AT = '2026-10-19T08:00:00Z';

function steppingClock() {
    let tick = 0;
    return { now: () => new Date(Date.parse(AT) + 1000 * tick++) };
}

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function code(response: EngineApiResponse<unknown>): string {
    return response.kind === 'problem' ? response.problem.code : 'ok';
}

const signal = () => AbortSignal.timeout(5_000);
const engine = (options: InMemoryEngineApiOptions = {}): EngineApiClient =>
    createInMemoryEngineApiClient({ clock: steppingClock(), ...options });
const names = (items: readonly { readonly name: string }[]) => items.map(({ name }) => name);

describe('in-memory agents', () => {
    async function fleet(client: EngineApiClient) {
        const folder = ok(await client.folders.create({ name: 'Team' }, signal()));
        const ada = ok(await client.agents.create({ source: 'Ada\nPERSONA Reviews code' }, signal()));
        const bob = ok(
            await client.agents.create({ source: 'Bob', folderId: folder.id, visibility: 'public' }, signal()),
        );
        const cid = ok(await client.agents.create({ source: 'Cid' }, signal()));
        ok(await client.agents.start(bob.id, signal()));
        ok(await client.agents.delete(cid.id, signal()));
        return { folder, ada, bob, cid };
    }

    it('filters and sorts the list', async () => {
        const client = engine();
        const { folder } = await fleet(client);
        const list = async (query: Parameters<EngineApiClient['agents']['list']>[0]) =>
            names(ok(await client.agents.list(query, signal())).items);
        expect(await list({ q: 'REVIEWS' })).toEqual(['Ada']);
        expect(await list({ folderId: folder.id })).toEqual(['Bob']);
        expect(await list({ visibility: 'public' })).toEqual(['Bob']);
        expect(await list({ status: 'running' })).toEqual(['Bob']);
        expect(await list({ deleted: 'include' })).toEqual(['Ada', 'Bob', 'Cid']);
        expect(await list({ deleted: 'include', sort: '-createdAt' })).toEqual(['Cid', 'Bob', 'Ada']);
        expect(await list({ deleted: 'include', sort: 'createdAt' })).toEqual(['Ada', 'Bob', 'Cid']);
        expect(await list({ deleted: 'include', sort: '-updatedAt' })).toEqual(['Cid', 'Bob', 'Ada']);
    });

    it('refuses unknown folders, missing and deleted agents', async () => {
        const client = engine();
        const { ada, cid } = await fleet(client);
        const missing = AgentId.parse('missing');
        const nowhere = FolderId.parse('nowhere');
        expect(code(await client.agents.create({ source: 'Dot', folderId: nowhere }, signal()))).toBe(
            'validation-failed',
        );
        expect(code(await client.agents.update(ada.id, { folderId: nowhere }, signal()))).toBe('validation-failed');
        expect(code(await client.agents.update(missing, {}, signal()))).toBe('not-found');
        expect(code(await client.agents.delete(missing, signal()))).toBe('not-found');
        expect(code(await client.agents.restore(missing, signal()))).toBe('not-found');
        expect(code(await client.agents.getSource(missing, signal()))).toBe('not-found');
        expect(code(await client.agents.listRevisions(missing, {}, signal()))).toBe('not-found');
        expect(code(await client.agents.getStatus(missing, signal()))).toBe('not-found');
        expect(code(await client.agents.start(missing, signal()))).toBe('not-found');
        expect(code(await client.agents.stop(missing, signal()))).toBe('not-found');
        expect(code(await client.agents.start(cid.id, signal()))).toBe('agent-deleted');
        expect(
            code(
                await client.agents.updateSource(
                    cid.id,
                    { source: 'Cid', baseRevisionId: cid.currentRevisionId },
                    signal(),
                ),
            ),
        ).toBe('agent-deleted');
        expect(
            code(
                await client.agents.updateSource(
                    ada.id,
                    { source: '', baseRevisionId: ada.currentRevisionId },
                    signal(),
                ),
            ),
        ).toBe('invalid-book');
        expect(code(await client.chats.create({ agentId: cid.id }, signal()))).toBe('agent-deleted');
        expect(code(await client.chats.list(missing, {}, signal()))).toBe('not-found');
    });

    it('is idempotent on delete, restore, start and stop', async () => {
        const client = engine();
        const { ada, bob, cid } = await fleet(client);
        expect(ok(await client.agents.delete(cid.id, signal())).deletedAt).not.toBeNull();
        expect(ok(await client.agents.restore(ada.id, signal())).deletedAt).toBeNull();
        expect(ok(await client.agents.start(bob.id, signal())).state).toBe('running');
        expect(ok(await client.agents.stop(ada.id, signal())).state).toBe('idle');
        expect(ok(await client.agents.stop(bob.id, signal())).state).toBe('stopped');
        expect(ok(await client.agents.getStatus(bob.id, signal())).state).toBe('stopped');
        const moved = ok(await client.agents.update(ada.id, { visibility: 'unlisted', folderId: null }, signal()));
        expect(moved).toMatchObject({ visibility: 'unlisted', folderId: null });
    });
});

describe('in-memory folders and chats', () => {
    it('renames folders and refuses taken names', async () => {
        const client = engine();
        const team = ok(await client.folders.create({ name: 'Team' }, signal()));
        ok(await client.folders.create({ name: 'Ops' }, signal()));
        expect(code(await client.folders.rename(team.id, { name: 'OPS' }, signal()))).toBe('name-taken');
        expect(ok(await client.folders.rename(team.id, { name: 'Core' }, signal())).name).toBe('Core');
        expect(code(await client.folders.rename(FolderId.parse('nope'), { name: 'X' }, signal()))).toBe('not-found');
        expect(names(ok(await client.folders.list({}, signal())).items)).toEqual(['Core', 'Ops']);
    });

    it('refuses messages to missing chats; a deleted agent no longer answers', async () => {
        const client = engine();
        const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
        const chat = ok(await client.chats.create({ agentId: agent.id }, signal()));
        expect(chat.title).toBe('Chat with Ada');
        expect(ok(await client.chats.list(agent.id, {}, signal())).items).toEqual([chat]);
        const missing = ChatId.parse('nope');
        expect(code(await client.chats.listEntries(missing, {}, signal()))).toBe('not-found');
        expect(code(await client.chats.sendMessage(missing, { content: 'hi' }, signal()))).toBe('not-found');
        expect(code(await client.chats.cancelReply(chat.id, MessageId.parse('nope'), signal()))).toBe('not-found');
        const sent = ok(await client.chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        expect(code(await client.chats.cancelReply(chat.id, sent.message.id, signal()))).toBe('not-found');
        ok(await client.agents.delete(agent.id, signal()));
        ok(await client.chats.sendMessage(chat.id, { content: 'anyone?' }, signal()));
        expect(ok(await client.chats.get(chat.id, signal())).messageCount).toBe(3);
    });

    it('streams chat changes only to members who may read chats', async () => {
        const client = engine({ member: { permissions: PERMISSIONS.filter((p) => p !== 'chats.read') } });
        const controller = new AbortController();
        const iterator = ok(await client.events.stream({}, controller.signal))[Symbol.asyncIterator]();
        const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
        ok(await client.chats.create({ agentId: agent.id }, signal()));
        ok(await client.agents.start(agent.id, signal()));
        const nextType = async () => {
            const result = await iterator.next();
            if (result.done === true) throw new Error('Stream ended');
            return result.value.event.type;
        };
        expect(await nextType()).toBe('agent.changed');
        expect(await nextType()).toBe('agent.status');
        const pending = iterator.next();
        controller.abort();
        await expect(pending).rejects.toThrow();
        await expect(client.events.stream({}, controller.signal)).rejects.toThrow();
    });
});

describe('in-memory members, invites, tokens and settings', () => {
    it('manages members and invites', async () => {
        const client = engine({
            seed: {
                members: [
                    {
                        id: 'member-2',
                        displayName: 'Bob',
                        role: 'member',
                        status: 'active',
                        createdAt: AT,
                        lastSeenAt: null,
                    },
                ],
            },
        });
        const bob = MemberId.parse('member-2');
        expect(ok(await client.members.get(bob, signal())).displayName).toBe('Bob');
        expect(ok(await client.members.update(bob, { role: 'admin' }, signal())).role).toBe('admin');
        expect(ok(await client.members.remove(bob, signal()))).toBeNull();
        for (const response of [
            await client.members.get(bob, signal()),
            await client.members.update(bob, { role: 'viewer' }, signal()),
            await client.members.remove(bob, signal()),
            await client.members.revokeInvite(InviteId.parse('nope'), signal()),
        ]) {
            expect(code(response)).toBe('not-found');
        }
        expect(code(await client.members.createInvite({ role: 'member', expiresAt: AT }, signal()))).toBe(
            'validation-failed',
        );
        const created = ok(
            await client.members.createInvite({ role: 'member', expiresAt: '2030-01-01T00:00:00Z' }, signal()),
        );
        expect(created.inviteUrl).toMatch(/^https:\/\/engine\.localhost\//);
        expect(ok(await client.members.listInvites({}, signal())).items).toEqual([created.invite]);
        expect(ok(await client.members.revokeInvite(created.invite.id, signal()))).toBeNull();
        const audit = ok(await client.audit.list({ targetKind: 'invite', targetId: created.invite.id }, signal()));
        expect(audit.items.map(({ action }) => action)).toEqual(['invite.revoke', 'invite.create']);
    });

    it('never grants a token more than its creator holds', async () => {
        const client = engine({ member: { permissions: ['api-tokens.manage', 'agents.read'] } });
        const future = '2030-01-01T00:00:00Z';
        const excess = await client.apiTokens.create(
            { name: 'CI', permissions: ['agents.write'], expiresAt: future },
            signal(),
        );
        expect(excess.kind === 'problem' && excess.problem.errors?.[0]?.path).toBe('body.permissions');
        expect(
            code(await client.apiTokens.create({ name: 'CI', permissions: ['agents.read'], expiresAt: AT }, signal())),
        ).toBe('validation-failed');
        expect(code(await client.apiTokens.revoke(ApiTokenId.parse('nope'), signal()))).toBe('not-found');
    });

    it('updates settings and keeps the engine name in step', async () => {
        const client = engine();
        const settings = ok(
            await client.settings.update({ name: 'Lab', defaultAgentVisibility: 'unlisted' }, signal()),
        );
        expect(settings).toMatchObject({ name: 'Lab', defaultAgentVisibility: 'unlisted' });
        expect(ok(await client.settings.get(signal()))).toEqual(settings);
        expect(ok(await client.engine.get(signal())).name).toBe('Lab');
        expect(ok(await client.agents.create({ source: 'Ada' }, signal())).visibility).toBe('unlisted');
        expect(ok(await client.settings.setUpdatePolicy({ policy: 'auto' }, signal()))).toEqual({
            policy: 'auto',
            pinnedVersion: null,
        });
    });
});

describe('in-memory credentials (admin view)', () => {
    const client = () =>
        engine({
            seed: {
                passkeys: [
                    { id: 'pk-1', memberId: 'member-owner', name: 'a', createdAt: AT, lastUsedAt: null },
                    { id: 'pk-2', memberId: 'member-owner', name: 'b', createdAt: AT, lastUsedAt: null },
                    { id: 'pk-3', memberId: 'member-2', name: 'c', createdAt: AT, lastUsedAt: null },
                ],
                sessions: [
                    {
                        id: 's-1',
                        memberId: 'member-owner',
                        current: true,
                        client: null,
                        createdAt: AT,
                        lastSeenAt: AT,
                        expiresAt: AT,
                    },
                    {
                        id: 's-2',
                        memberId: 'member-2',
                        current: false,
                        client: null,
                        createdAt: AT,
                        lastSeenAt: AT,
                        expiresAt: AT,
                    },
                ],
            },
        });

    it("filters by member and revokes anyone's credentials with members.manage", async () => {
        const admin = client();
        const other = MemberId.parse('member-2');
        expect(ok(await admin.passkeys.list({ memberId: other }, signal())).items.map(({ id }) => id)).toEqual([
            'pk-3',
        ]);
        expect(ok(await admin.sessions.list({ memberId: other }, signal())).items.map(({ id }) => id)).toEqual(['s-2']);
        expect(ok(await admin.passkeys.revoke(PasskeyId.parse('pk-1'), signal()))).toBeNull();
        expect(code(await admin.passkeys.revoke(PasskeyId.parse('pk-3'), signal()))).toBe('last-passkey');
        expect(code(await admin.passkeys.revoke(PasskeyId.parse('nope'), signal()))).toBe('not-found');
        expect(ok(await admin.sessions.revoke(SessionId.parse('s-2'), signal()))).toBeNull();
        expect(code(await admin.sessions.revoke(SessionId.parse('s-2'), signal()))).toBe('not-found');
    });
});

describe('in-memory wallet and files', () => {
    const request = {
        origin: 'https://github.com',
        account: 'ada@example.com',
        problem: 'missing',
        fields: [],
        recordId: null,
        reason: 'Ada needs GitHub.',
        tasks: ['Review'],
        agents: ['Ada'],
    } as const;
    const updatedBody = { origin: 'https://github.com', username: 'ada', password: 'p' };
    const request_ = request;

    it('saves logins without keeping a secret and resolves the requests they answer', async () => {
        const { client, controller } = createInMemoryEngine({ clock: steppingClock() });
        const github = controller.requestWalletLogin(request);
        const codeRequest = controller.requestWalletLogin({ ...request, account: null, problem: 'code' });
        expect(controller.requestWalletLogin(request)).toMatchObject({ id: github.id, requests: 2, step: 0 });
        const saved = ok(
            await client.wallet.add(
                {
                    origin: 'https://www.github.com',
                    username: 'ada@example.com',
                    password: 'hunter2-canary',
                    fields: [{ label: 'PIN', value: '0000-canary' }],
                },
                signal(),
            ),
        );
        expect(saved.record).toMatchObject({ label: 'github.com · ad…@example.com', verification: null });
        expect(saved.record.fields).toEqual([{ label: 'PIN', uncertain: false }]);
        expect(saved.resolvedRequestIds).toEqual([github.id]);
        const again = ok(
            await client.wallet.add(
                {
                    origin: 'https://www.github.com',
                    username: 'ADA@example.com',
                    password: 'p',
                    requestId: codeRequest.id,
                },
                signal(),
            ),
        );
        expect(again.record.id).toBe(saved.record.id);
        expect(again.resolvedRequestIds).toEqual([]);
        const updated = ok(
            await client.wallet.update(
                saved.record.id,
                {
                    origin: 'https://github.com',
                    username: 'ada',
                    password: 'p',
                    label: 'Work GitHub',
                    fields: [{ label: 'pin', value: '' }],
                },
                signal(),
            ),
        );
        expect(updated.record).toMatchObject({ label: 'Work GitHub', fields: [] });
        const overview = ok(await client.wallet.get(signal()));
        expect(overview.records).toHaveLength(1);
        expect(overview.pending.map(({ id }) => id)).toEqual([codeRequest.id]);
        expect(JSON.stringify([saved, again, updated, overview])).not.toMatch(/canary/);
        const tooMany = Array.from({ length: 13 }, (_, index) => ({ label: `F${String(index)}`, value: 'v' }));
        expect(code(await client.wallet.update(saved.record.id, { ...updatedBody, fields: tooMany }, signal()))).toBe(
            'validation-failed',
        );
        const missing = WalletRecordId.parse('nope');
        expect(code(await client.wallet.update(missing, updatedBody, signal()))).toBe('not-found');
        ok(await client.wallet.delete(saved.record.id, signal()));
        expect(code(await client.wallet.delete(saved.record.id, signal()))).toBe('not-found');
    });

    it('marks a request seen for its step only and rejects it for good', async () => {
        const { client, controller } = createInMemoryEngine({ clock: steppingClock() });
        const first = controller.requestWalletLogin(request);
        const seen = ok(await client.wallet.markSeen(first.id, { step: 0 }, signal()));
        expect(seen.seenAt).not.toBeNull();
        expect(ok(await client.wallet.markSeen(first.id, { step: 0 }, signal())).seenAt).toBe(seen.seenAt);
        const moved = controller.requestWalletLogin({ ...request, problem: 'rejected' });
        expect(moved).toMatchObject({ id: first.id, step: 1, seenAt: null });
        expect(code(await client.wallet.markSeen(first.id, { step: 0 }, signal()))).toBe('wallet-request-moved');
        expect(code(await client.wallet.reject(first.id, { step: 0 }, signal()))).toBe('wallet-request-moved');
        ok(await client.wallet.reject(first.id, { step: 1 }, signal()));
        expect(ok(await client.wallet.get(signal())).pending).toEqual([]);
        expect(code(await client.wallet.reject(first.id, { step: 1 }, signal()))).toBe('not-found');
        expect(code(await client.wallet.markSeen(first.id, { step: 1 }, signal()))).toBe('not-found');
    });

    it('asks for a fresh passkey to add, update or remove a login, not to answer a request', async () => {
        const { client, controller } = createInMemoryEngine({ clock: steppingClock(), stepUp: 'required' });
        const login = WalletRecordId.parse('login-1');
        expect(code(await client.wallet.add(updatedBody, signal()))).toBe('step-up-required');
        expect(code(await client.wallet.update(login, updatedBody, signal()))).toBe('step-up-required');
        expect(code(await client.wallet.delete(login, signal()))).toBe('step-up-required');
        const request = controller.requestWalletLogin(request_);
        ok(await client.wallet.markSeen(request.id, { step: 0 }, signal()));
        ok(await client.wallet.reject(request.id, { step: 0 }, signal()));
    });

    it('accepts no write and shows no login until the Wallet is ready', async () => {
        const { client, controller } = createInMemoryEngine({ clock: steppingClock() });
        const saved = ok(await client.wallet.add(updatedBody, signal()));
        controller.setWalletState('locked', 3);
        expect(ok(await client.wallet.get(signal()))).toMatchObject({ state: 'locked', records: [], lockedRecords: 3 });
        expect(code(await client.wallet.add(updatedBody, signal()))).toBe('wallet-not-ready');
        expect(code(await client.wallet.delete(saved.record.id, signal()))).toBe('wallet-not-ready');
        controller.setWalletState('empty');
        expect(ok(await client.wallet.get(signal()))).toMatchObject({ state: 'empty', lockedRecords: 0 });
    });

    it('refuses oversized files and missing ones', async () => {
        const client = engine();
        const big = new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]);
        expect(code(await client.files.upload({ file: big, name: 'big.bin', purpose: 'upload' }, signal()))).toBe(
            'payload-too-large',
        );
        const plain = ok(await client.files.upload({ file: new Blob(['x']), name: 'x', purpose: 'upload' }, signal()));
        expect(plain.contentType).toBe('application/octet-stream');
        const missing = FileId.parse('nope');
        expect(code(await client.files.download(missing, {}, signal()))).toBe('not-found');
        expect(code(await client.files.delete(missing, signal()))).toBe('not-found');
    });
});

describe('in-memory audit and transport', () => {
    it('filters audit entries by member, action, outcome and target', async () => {
        const client = engine({
            seed: {
                auditEntries: [
                    {
                        at: AT,
                        actor: { kind: 'system' },
                        action: 'ui.update.install',
                        target: null,
                        outcome: 'success',
                        client: null,
                    },
                ],
            },
        });
        const folder = ok(await client.folders.create({ name: 'A' }, signal()));
        expect(code(await client.folders.create({ name: 'a' }, signal()))).toBe('name-taken');
        const list = async (query: Parameters<EngineApiClient['audit']['list']>[0]) =>
            ok(await client.audit.list(query, signal())).items.map(({ seq }) => seq);
        expect(await list({ memberId: MemberId.parse('member-owner') })).toEqual([3, 2]);
        expect(await list({ action: 'ui.update.install' })).toEqual([1]);
        expect(await list({ outcome: 'failed' })).toEqual([3]);
        expect(await list({ targetKind: 'folder', targetId: folder.id })).toEqual([2]);
        expect(await list({ targetId: 'other' })).toEqual([]);
    });

    it('records validation failures and refuses input a route does not take', async () => {
        const { transport } = createInMemoryEngineApiTransport();
        const refused = await transport(ENGINE_API_ROUTES.getMe, { query: { extra: '1' }, body: { x: 1 } }, signal());
        expect(refused.kind === 'problem' && refused.problem.errors?.map(({ path }) => path)).toEqual([
            'query',
            'body',
        ]);
        const invalid = await transport(ENGINE_API_ROUTES.createFolder, { body: { name: '' } }, signal());
        expect(code(invalid)).toBe('validation-failed');
        const audit = await transport(ENGINE_API_ROUTES.listAuditEntries, {}, signal());
        expect(audit.kind === 'ok' && audit.data).toMatchObject({
            items: [{ action: 'folder.create', outcome: 'failed', target: null }],
        });
        await expect(transport(ENGINE_API_ROUTES.getMe, {}, AbortSignal.abort())).rejects.toThrow();
    });
});
