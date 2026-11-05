import { describe, expect, it } from 'vitest';

import { createEngineApiClient } from '../client';
import type { EngineApiClient, EngineApiResponse } from '../client';
import { ClientInfo, MemberId, SessionId } from '../common';
import type { ReadEngineEvent } from '../events';
import { createInMemoryEngineCore } from '../in-memory-client';
import type { Authorizer, InMemoryEngineCoreOptions } from '../in-memory-client';
import { OWNER_PERMISSIONS } from '../permissions';
import type { Permission } from '../permissions';
import { withClientReading } from '../reader';
import type { EngineApiStreamItem } from '../route';
import { ENGINE_API_ROUTES } from '../routes';
import type { Actor, Sleep } from './kit';

import { MessageId } from '../common';
/** The in-memory engine numbers messages `<chat>#<position>`, and a reply follows its User message directly. */
const replyIdOf = (sent: { readonly message: { readonly id: string } }) =>
    MessageId.parse(sent.message.id.replace(/#(\d+)$/, (_, position: string) => `#${String(Number(position) + 1)}`));

const AT = '2026-10-19T08:00:00Z';

function steppingClock() {
    let tick = 0;
    return { now: () => new Date(Date.parse(AT) + 1000 * tick++) };
}

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function problemOf(response: EngineApiResponse<unknown>) {
    if (response.kind !== 'problem') throw new Error('Expected a problem');
    return response.problem;
}

const signal = () => AbortSignal.timeout(5_000);

const member = (id: string, role: 'owner' | 'admin' | 'member' | 'viewer') => ({
    id,
    displayName: id,
    role,
    status: 'active' as const,
    createdAt: AT,
    lastSeenAt: null,
});

const session = (id: string, memberId: string) => ({
    id,
    memberId,
    current: false,
    client: null,
    createdAt: AT,
    lastSeenAt: AT,
    expiresAt: '2026-10-20T08:00:00Z',
});

function actor(
    memberId: string,
    sessionId: string,
    permissions: readonly Permission[] = OWNER_PERMISSIONS,
    fields: Partial<Actor> = {},
): Actor {
    return {
        memberId: MemberId.parse(memberId),
        sessionId: SessionId.parse(sessionId),
        client: ClientInfo.parse({ ip: '198.51.100.7', userAgent: `agent of ${memberId}` }),
        permissions: new Set(permissions),
        stepUpFresh: true,
        ...fields,
    };
}

/** An owner and a member on one core, each with their own session. */
function team(options: InMemoryEngineCoreOptions = {}) {
    const core = createInMemoryEngineCore({
        clock: steppingClock(),
        member: { id: 'member-owner', role: 'owner' },
        seed: {
            members: [member('member-owner', 'owner'), member('member-ada', 'member')],
            sessions: [session('session-owner', 'member-owner'), session('session-ada', 'member-ada')],
        },
        ...options,
    });
    const clientFor = (who: Actor): EngineApiClient => createEngineApiClient(withClientReading(core.transport(who)));
    const ownerActor = actor('member-owner', 'session-owner');
    const adaActor = actor('member-ada', 'session-ada', ['agents.read', 'agents.write', 'members.read']);
    return { core, owner: clientFor(ownerActor), ada: clientFor(adaActor), clientFor, ownerActor, adaActor };
}

async function next<T>(iterator: AsyncIterator<EngineApiStreamItem<T>>): Promise<EngineApiStreamItem<T>> {
    const result = await iterator.next();
    if (result.done === true) throw new Error('stream ended');
    return result.value;
}

/** A `Sleep` the test releases one call at a time. */
function steppedSleep() {
    const pending: { resolve: () => void; ms: number }[] = [];
    const waiters: (() => void)[] = [];
    const sleep: Sleep = (ms, abort) =>
        new Promise((resolve, reject) => {
            const entry = { resolve, ms };
            pending.push(entry);
            for (const wake of waiters.splice(0)) wake();
            abort.addEventListener(
                'abort',
                () => {
                    pending.splice(pending.indexOf(entry), 1);
                    reject(abort.reason as Error);
                },
                { once: true },
            );
        });
    return {
        sleep,
        pending: () => pending.map(({ ms }) => ms),
        /** Waits for the generator's next sleep, then ends it. */
        async step(): Promise<void> {
            while (pending.length === 0) await new Promise<void>((wake) => waiters.push(wake));
            pending.shift()?.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
        },
    };
}

describe('in-memory core: per-request actor', () => {
    it('gives each actor their own permissions, audit entries and current session', async () => {
        const { owner, ada } = team();
        expect(ok(await owner.me.get(signal()))).toMatchObject({ memberId: 'member-owner', role: 'owner' });
        expect(ok(await ada.me.get(signal()))).toMatchObject({
            memberId: 'member-ada',
            role: 'member',
            permissions: ['agents.read', 'agents.write', 'members.read'],
        });
        ok(await ada.agents.create({ source: 'Ada' }, signal()));
        expect(
            problemOf(await ada.secrets.create({ name: 'K', scope: { kind: 'engine' }, value: 'v' }, signal())),
        ).toMatchObject({ status: 403, requiredPermission: 'secrets.manage' });
        ok(await owner.folders.create({ name: 'Team' }, signal()));
        const audit = ok(await owner.audit.list({}, signal())).items;
        expect(audit.map(({ action, outcome, actor: who, client }) => [action, outcome, who, client])).toEqual([
            [
                'folder.create',
                'success',
                { kind: 'member', memberId: 'member-owner' },
                { ip: '198.51.100.7', userAgent: 'agent of member-owner' },
            ],
            [
                'secret.create',
                'denied',
                { kind: 'member', memberId: 'member-ada' },
                { ip: '198.51.100.7', userAgent: 'agent of member-ada' },
            ],
            [
                'agent.create',
                'success',
                { kind: 'member', memberId: 'member-ada' },
                { ip: '198.51.100.7', userAgent: 'agent of member-ada' },
            ],
        ]);
        const sessions = ok(await owner.sessions.list({}, signal())).items;
        expect(sessions.map(({ id, current }) => [id, current]).sort()).toEqual([
            ['session-ada', false],
            ['session-owner', true],
        ]);
        expect(ok(await ada.me.listSessions({}, signal())).items).toMatchObject([{ id: 'session-ada', current: true }]);
    });

    it("filters the event stream by each actor's permissions", async () => {
        const { owner, ada } = team();
        const controller = new AbortController();
        const ownerEvents = ok(await owner.events.stream({}, controller.signal))[Symbol.asyncIterator]();
        const adaEvents = ok(await ada.events.stream({}, controller.signal))[Symbol.asyncIterator]();
        const agent = ok(await owner.agents.create({ source: 'Ada' }, signal()));
        const chat = ok(await owner.chats.create({ agentId: agent.id, title: 'Hello' }, signal()));
        ok(await owner.agents.update(agent.id, { visibility: 'public' }, signal()));
        const ownerSeen: ReadEngineEvent[] = [];
        for (let index = 0; index < 3; index++) ownerSeen.push((await next(ownerEvents)).event);
        expect(ownerSeen.map(({ type }) => type)).toEqual(['agent.changed', 'chat.changed', 'agent.changed']);
        expect(ownerSeen[1]).toEqual({ type: 'chat.changed', chatId: chat.id });
        // Ada lacks chats.read: she sees both agent changes and never the chat.
        expect((await next(adaEvents)).id).toBe('1');
        expect((await next(adaEvents)).id).toBe('3');
        controller.abort();
    });

    it('signs out a member who was removed, on their next request', async () => {
        const { owner, ada, core } = team();
        ok(await owner.members.remove(MemberId.parse('member-ada'), signal()));
        expect(problemOf(await ada.me.get(signal()))).toMatchObject({ status: 401, code: 'unauthenticated' });
        expect(core.controller.inspect().sessions.map(({ id }) => id)).toEqual(['session-owner']);
    });

    it('applies a role change on the next request', async () => {
        const { owner, ada } = team();
        ok(await owner.members.update(MemberId.parse('member-ada'), { role: 'viewer' }, signal()));
        expect(ok(await ada.me.get(signal())).role).toBe('viewer');
    });

    it('drops revoked sessions from the session list', async () => {
        const { core, owner, clientFor } = team();
        core.controller.addSession(session('session-owner-2', 'member-owner'));
        core.controller.addSession(session('session-owner-3', 'member-owner'));
        ok(await owner.sessions.revoke(SessionId.parse('session-ada'), signal()));
        ok(await owner.me.revokeSession(SessionId.parse('session-owner-2'), signal()));
        expect(core.controller.inspect().sessions.map(({ id }) => id)).toEqual(['session-owner', 'session-owner-3']);
        const other = clientFor(actor('member-owner', 'session-owner-3'));
        expect(ok(await other.me.revokeOtherSessions(signal()))).toEqual({ revoked: 1 });
        expect(core.controller.inspect().sessions.map(({ id }) => id)).toEqual(['session-owner-3']);
    });

    it('asks for step-up when the actor has no fresh assertion', async () => {
        const { clientFor } = team();
        const stale = clientFor(actor('member-owner', 'session-owner', OWNER_PERMISSIONS, { stepUpFresh: false }));
        expect(problemOf(await stale.settings.setUpdatePolicy({ policy: 'manual' }, signal()))).toMatchObject({
            status: 401,
            code: 'step-up-required',
        });
    });
});

describe('in-memory core: authorizer', () => {
    it("asks the authorizer with the route's resource and answers a denial like a missing permission", async () => {
        const asked: unknown[] = [];
        const authorizer: Authorizer = {
            can: (who, permission, resource) => {
                asked.push([who.memberId, permission, resource]);
                if (!who.permissions.has(permission)) return { kind: 'deny', reason: 'missing-permission' };
                return resource?.kind === 'agent' &&
                    resource.createdBy !== undefined &&
                    resource.createdBy !== who.memberId
                    ? { kind: 'deny', reason: 'not-owner' }
                    : { kind: 'allow' };
            },
        };
        const { owner, ada } = team({ authorizer });
        const agent = ok(await owner.agents.create({ source: 'Grace' }, signal()));
        asked.length = 0;
        const denied = problemOf(await ada.agents.update(agent.id, { visibility: 'public' }, signal()));
        expect(denied).toEqual(
            expect.objectContaining({ status: 403, code: 'forbidden', requiredPermission: 'agents.write' }),
        );
        expect(asked).toEqual([
            ['member-ada', 'agents.write', { kind: 'agent', id: agent.id, createdBy: 'member-owner' }],
        ]);
        expect(problemOf(await ada.agents.update(agent.id, { visibility: 'bogus' } as never, signal())).status).toBe(
            403,
        );
        const own = ok(await ada.agents.create({ source: 'Ada' }, signal()));
        ok(await ada.agents.update(own.id, { visibility: 'public' }, signal()));
        // An unknown ID carries no owner, so the route's own 404 answers.
        expect(problemOf(await ada.agents.update('nope' as never, { visibility: 'public' }, signal())).code).toBe(
            'not-found',
        );
        const audit = ok(await owner.audit.list({ outcome: 'denied' }, signal())).items;
        expect(audit[0]).toMatchObject({
            action: 'agent.update',
            target: { kind: 'agent', id: agent.id },
            actor: { kind: 'member', memberId: 'member-ada' },
        });
    });

    it('resolves the owner of every kind of resource a route names', async () => {
        const seen: unknown[] = [];
        const { owner, core } = team({
            authorizer: {
                can: (_, permission, resource) => {
                    seen.push(resource);
                    return { kind: 'allow' };
                },
            },
        });
        const agent = ok(await owner.agents.create({ source: 'Ada' }, signal()));
        const chat = ok(await owner.chats.create({ agentId: agent.id, title: 'x' }, signal()));
        const sent = ok(await owner.chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        const secret = ok(await owner.secrets.create({ name: 'K', scope: { kind: 'engine' }, value: 'v' }, signal()));
        const folder = ok(await owner.folders.create({ name: 'F' }, signal()));
        const token = ok(
            await owner.apiTokens.create(
                { name: 'CI', permissions: ['agents.read'], expiresAt: '2027-01-01T00:00:00Z' },
                signal(),
            ),
        );
        const invite = ok(
            await owner.members.createInvite({ role: 'viewer', expiresAt: '2027-01-01T00:00:00Z' }, signal()),
        );
        const file = ok(
            await owner.files.upload({ file: new Blob(['x']), name: 'x.txt', purpose: 'upload' }, signal()),
        );
        const run = ok(await owner.runs.list({}, signal())).items[0];
        const trigger = ok(
            await owner.triggers.create(
                {
                    kind: 'schedule',
                    agentId: agent.id,
                    name: 'T',
                    recurrence: { kind: 'interval', everySeconds: 60 },
                    message: 'm',
                },
                signal(),
            ),
        );
        const integration = ok(
            await owner.integrations.create(
                { kind: 'mcp-server', name: 'I', agentId: null, url: 'https://mcp.example.com/', secretNames: [] },
                signal(),
            ),
        );
        seen.length = 0;
        await owner.agents.getRevision(agent.id, agent.currentRevisionId, signal());
        await owner.chats.cancelReply(chat.id, replyIdOf(sent), signal());
        await owner.secrets.revoke(secret.id, signal());
        await owner.folders.rename(folder.id, { name: 'G' }, signal());
        await owner.apiTokens.revoke(token.apiToken.id, signal());
        await owner.members.revokeInvite(invite.invite.id, signal());
        await owner.members.get(MemberId.parse('member-ada'), signal());
        await owner.passkeys.revoke('passkey-owner' as never, signal());
        await owner.sessions.revoke(SessionId.parse('session-ada'), signal());
        await owner.files.get(file.id, signal());
        if (run) await owner.runs.get(run.id, signal());
        await owner.triggers.get(trigger.id, signal());
        await owner.integrations.get(integration.id, signal());
        expect(seen).toEqual([
            { kind: 'revision', id: agent.currentRevisionId, createdBy: 'member-owner' },
            { kind: 'message', id: replyIdOf(sent), createdBy: null },
            { kind: 'secret', id: secret.id, createdBy: 'member-owner' },
            { kind: 'folder', id: folder.id },
            { kind: 'api-token', id: token.apiToken.id, createdBy: 'member-owner' },
            { kind: 'invite', id: invite.invite.id, createdBy: 'member-owner' },
            { kind: 'member', id: 'member-ada' },
            { kind: 'passkey', id: 'passkey-owner', createdBy: 'member-owner' },
            { kind: 'session', id: 'session-ada', createdBy: 'member-ada' },
            { kind: 'file', id: file.id, createdBy: 'member-owner' },
            ...(run ? [{ kind: 'run', id: run.id, createdBy: 'member-owner' }] : []),
            { kind: 'trigger', id: trigger.id, createdBy: 'member-owner' },
            { kind: 'integration', id: integration.id, createdBy: 'member-owner' },
        ]);
        expect(core.controller.inspect().counts.members).toBe(2);
    });
});

describe('in-memory core: chat writes', () => {
    const CHATTER: readonly Permission[] = ['agents.read', 'chats.read', 'chats.write'];

    it('lets every member with chats.write write in any thread: nobody owns one', async () => {
        const { owner, clientFor } = team({ authorizer: { can: () => ({ kind: 'allow' }) } });
        const ada = clientFor(actor('member-ada', 'session-ada', CHATTER));
        const agent = ok(await owner.agents.create({ source: 'Grace' }, signal()));
        const chat = ok(await owner.chats.create({ agentId: agent.id, title: 'Shared' }, signal()));
        ok(await owner.chats.sendMessage(chat.id, { content: 'first' }, signal()));
        const sent = ok(await ada.chats.sendMessage(chat.id, { content: 'second' }, signal()));
        expect(sent.message).toMatchObject({ author: { kind: 'user', key: 'user' }, createdBy: 'member-ada' });
        expect(ok(await ada.chats.cancelReply(chat.id, replyIdOf(sent), signal())).status).toBe('cancelled');
        expect(ok(await owner.chats.get(chat.id, signal())).messageCount).toBe(4);
        expect(problemOf(await ada.chats.sendMessage('chat-unknown' as never, { content: 'x' }, signal())).code).toBe(
            'not-found',
        );
    });

    it('keeps unread per member: writing or marking read clears only your own', async () => {
        const { owner, clientFor } = team({ authorizer: { can: () => ({ kind: 'allow' }) } });
        const ada = clientFor(actor('member-ada', 'session-ada', CHATTER));
        const agent = ok(await owner.agents.create({ source: 'Grace' }, signal()));
        const chat = ok(await owner.chats.create({ agentId: agent.id }, signal()));
        const sent = ok(await owner.chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        ok(await owner.chats.cancelReply(chat.id, replyIdOf(sent), signal()));
        expect(ok(await owner.chats.get(chat.id, signal())).unread).toBe(1);
        expect(ok(await ada.chats.get(chat.id, signal())).unread).toBe(1);
        expect(ok(await ada.chats.markRead(chat.id, signal())).unread).toBe(0);
        expect(ok(await owner.chats.get(chat.id, signal())).unread).toBe(1);
    });
});

describe('in-memory core: bounded event buffer', () => {
    function withEvents(count: number) {
        const { owner, core } = team({ eventBufferSize: 3 });
        for (let index = 0; index < count; index++) {
            core.controller.emit({ type: 'agent.changed', agentId: `agent-${String(index + 1)}` });
        }
        return { owner, core };
    }

    async function replay(client: EngineApiClient, lastEventId: string | undefined, count: number) {
        const controller = new AbortController();
        const iterator = ok(
            await client.events.stream(lastEventId === undefined ? {} : { lastEventId }, controller.signal),
        )[Symbol.asyncIterator]();
        const ids: (string | null)[] = [];
        for (let index = 0; index < count; index++) ids.push((await next(iterator)).id);
        controller.abort();
        return ids;
    }

    it('keeps only the newest events, with IDs that keep increasing', async () => {
        const { owner } = withEvents(5);
        expect(await replay(owner, '4', 1)).toEqual(['5']);
        expect(await replay(owner, '3', 2)).toEqual(['4', '5']);
    });

    it('resumes from the oldest buffered event after an expired or unknown Last-Event-ID', async () => {
        const { owner } = withEvents(5);
        expect(await replay(owner, '1', 3)).toEqual(['3', '4', '5']);
        expect(await replay(owner, 'garbage', 3)).toEqual(['3', '4', '5']);
    });

    it('starts after the newest event without Last-Event-ID, and from nothing when the buffer is empty', async () => {
        const { owner, core } = withEvents(0);
        const controller = new AbortController();
        const iterator = ok(await owner.events.stream({ lastEventId: '9' }, controller.signal))[Symbol.asyncIterator]();
        const pending = next(iterator);
        core.controller.emit({ type: 'agent.changed', agentId: 'agent-x' });
        expect((await pending).id).toBe('1');
        controller.abort();
    });

    it('refuses a buffer that cannot hold an event', () => {
        expect(() => createInMemoryEngineCore({ eventBufferSize: 0 })).toThrow(RangeError);
    });
});

describe('in-memory core: paced replies', () => {
    async function pacedChat(outcome?: 'failed') {
        const paced = steppedSleep();
        const inputs: unknown[] = [];
        const { owner, core } = team({
            sleep: paced.sleep,
            replyScript: (input) => {
                inputs.push({ chatId: input.chatId, messageIndex: input.messageIndex, content: input.content });
                return {
                    chunks: [{ text: 'a', delayMs: 10 }, { text: 'b', delayMs: 20 }, 'c'],
                    ...(outcome === undefined ? {} : { outcome }),
                };
            },
        });
        const agent = ok(await owner.agents.create({ source: 'Ada' }, signal()));
        const chat = ok(await owner.chats.create({ agentId: agent.id, title: 'x' }, signal()));
        const sent = ok(await owner.chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        return { paced, inputs, owner, core, chat, sent };
    }

    const stream = async (client: EngineApiClient, chatId: string, messageId: string, lastEventId?: string) => {
        const controller = new AbortController();
        const items = ok(
            await client.chats.streamReply(
                chatId as never,
                messageId as never,
                lastEventId === undefined ? {} : { lastEventId },
                controller.signal,
            ),
        );
        return { iterator: items[Symbol.asyncIterator](), controller };
    };

    it('tells the script which chat and turn it answers', async () => {
        const { inputs, owner, chat, paced } = await pacedChat();
        for (let index = 0; index < 3; index++) await paced.step();
        ok(await owner.chats.sendMessage(chat.id, { content: 'again' }, signal()));
        expect(inputs).toEqual([
            { chatId: chat.id, messageIndex: 0, content: 'hi' },
            { chatId: chat.id, messageIndex: 2, content: 'again' },
        ]);
    });

    it('keeps generating without a reader and completes the message', async () => {
        const { paced, owner, chat, sent } = await pacedChat();
        expect(paced.pending()).toEqual([10]);
        await paced.step();
        await paced.step();
        expect(paced.pending()).toEqual([0]);
        await paced.step();
        expect(paced.pending()).toEqual([]);
        const messages = ok(await owner.chats.listEntries(chat.id, {}, signal())).items;
        expect(messages[0]).toMatchObject({ id: replyIdOf(sent), status: 'completed', content: 'abc' });
        const run = ok(await owner.runs.list({}, signal())).items[0];
        expect(run?.status).toBe('completed');
        const { iterator } = await stream(owner, chat.id, replyIdOf(sent), '1');
        expect((await next(iterator)).event).toEqual({ type: 'delta', seq: 2, text: 'b' });
        expect((await next(iterator)).event).toEqual({ type: 'delta', seq: 3, text: 'c' });
        expect((await next(iterator)).event).toMatchObject({ type: 'completed', message: { content: 'abc' } });
    });

    it('ends only the stream on a disconnect, and resumes it after Last-Event-ID', async () => {
        const { paced, owner, chat, sent } = await pacedChat();
        const first = await stream(owner, chat.id, replyIdOf(sent));
        const pending = next(first.iterator);
        await paced.step();
        expect(await pending).toEqual({ id: '1', event: { type: 'delta', seq: 1, text: 'a' } });
        const waiting = first.iterator.next();
        first.controller.abort();
        await expect(waiting).rejects.toThrow();
        await paced.step();
        const resumed = await stream(owner, chat.id, replyIdOf(sent), '1');
        expect((await next(resumed.iterator)).event).toEqual({ type: 'delta', seq: 2, text: 'b' });
        const last = next(resumed.iterator);
        await paced.step();
        expect((await last).event).toEqual({ type: 'delta', seq: 3, text: 'c' });
        expect((await next(resumed.iterator)).event).toMatchObject({ type: 'completed' });
    });

    it('stops generating only on cancel', async () => {
        const { paced, owner, chat, sent } = await pacedChat();
        const reader = await stream(owner, chat.id, replyIdOf(sent));
        await paced.step();
        expect((await next(reader.iterator)).event).toMatchObject({ seq: 1 });
        const waiting = next(reader.iterator);
        expect(ok(await owner.chats.cancelReply(chat.id, replyIdOf(sent), signal())).status).toBe('cancelled');
        expect((await waiting).event).toMatchObject({ type: 'failed', problem: { code: 'cancelled' } });
        expect(paced.pending()).toEqual([]);
        const messages = ok(await owner.chats.listEntries(chat.id, {}, signal())).items;
        expect(messages[0]).toMatchObject({ status: 'cancelled', content: '' });
        expect(ok(await owner.chats.cancelReply(chat.id, replyIdOf(sent), signal())).status).toBe('cancelled');
    });

    it('ends a failed script with reply-failed', async () => {
        const { paced, owner, chat, sent } = await pacedChat('failed');
        for (let index = 0; index < 3; index++) await paced.step();
        const { iterator } = await stream(owner, chat.id, replyIdOf(sent), '3');
        expect((await next(iterator)).event).toMatchObject({ type: 'failed', problem: { code: 'reply-failed' } });
        expect(ok(await owner.runs.list({}, signal())).items[0]?.status).toBe('failed');
    });

    it('waits through the timer by default', async () => {
        const { owner } = team({ replyScript: () => ({ chunks: [{ text: 'x', delayMs: 1 }] }) });
        const agent = ok(await owner.agents.create({ source: 'Ada' }, signal()));
        const chat = ok(await owner.chats.create({ agentId: agent.id, title: 'x' }, signal()));
        const sent = ok(await owner.chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        const { iterator } = await stream(owner, chat.id, replyIdOf(sent));
        expect((await next(iterator)).event).toEqual({ type: 'delta', seq: 1, text: 'x' });
        expect((await next(iterator)).event).toMatchObject({ type: 'completed', message: { content: 'x' } });
    });
});

describe('in-memory core: controller levers', () => {
    it('updates engine info and the security overview without touching capabilities', () => {
        const { core } = team({ capabilities: [{ id: 'runs', version: 1 }] });
        const engine = core.controller.updateEngine({ dashboardUrl: 'https://app.ptbk.test/engines/x' });
        expect(engine).toMatchObject({
            dashboardUrl: 'https://app.ptbk.test/engines/x',
            capabilities: [{ id: 'runs' }],
        });
        const security = core.controller.updateSecurity({
            relays: [{ hostname: 'relay-a.ptbk.test', status: 'connected', since: AT }],
        });
        expect(security.relays).toEqual([
            { hostname: 'relay-a.ptbk.test', status: 'connected', since: AT, lastPingRttMs: null },
        ]);
        expect(() => core.controller.updateSecurity({ relays: [{ hostname: 'x' }] } as never)).toThrow();
    });

    it('adds members and sessions, refusing duplicates and unknown members', () => {
        const { core } = team();
        core.controller.addMember(member('member-synthetic', 'member'));
        expect(() => core.controller.addMember(member('member-synthetic', 'viewer'))).toThrow();
        expect(core.controller.addSession(session('session-new', 'member-synthetic')).current).toBe(false);
        expect(() => core.controller.addSession(session('session-new', 'member-synthetic'))).toThrow();
        expect(() => core.controller.addSession(session('session-x', 'member-nobody'))).toThrow();
        expect(core.controller.removeSession('session-new')).toBe(true);
        expect(core.controller.removeSession('session-new')).toBe(false);
        const snapshot = core.controller.inspect();
        expect(snapshot.counts).toMatchObject({ members: 3, sessions: 2, agents: 0, auditEntries: 0 });
        expect(snapshot.members.map(({ id }) => id).sort()).toEqual(['member-ada', 'member-owner', 'member-synthetic']);
    });

    it("records a session's passkey, refusing someone else's or an unknown one", () => {
        const { core } = team();
        const signedIn = { ...session('session-pk', 'member-owner'), passkeyId: 'passkey-owner' };
        expect(core.controller.addSession(signedIn).passkeyId).toBe('passkey-owner');
        for (const passkeyId of ['passkey-owner', 'passkey-nobody']) {
            const foreign = { ...session(`session-${passkeyId}`, 'member-ada'), passkeyId };
            expect(() => core.controller.addSession(foreign), passkeyId).toThrow();
        }
    });

    it("removes a passkey, even a member's last one, with the sessions it signed in", () => {
        const { core } = team();
        core.controller.addSession({ ...session('session-pk', 'member-owner'), passkeyId: 'passkey-owner' });
        expect(core.controller.removePasskey('passkey-owner')).toBe(true);
        expect(core.controller.removePasskey('passkey-owner')).toBe(false);
        const snapshot = core.controller.inspect();
        expect(snapshot.passkeys).toEqual([]);
        expect(snapshot.sessions.map(({ id }) => id).sort()).toEqual(['session-ada', 'session-owner']);
    });

    it('adds a passkey the gateway registered and records its use', () => {
        const { core } = team();
        const passkey = {
            id: 'passkey-new',
            memberId: 'member-ada',
            name: 'Laptop',
            createdAt: AT,
            lastUsedAt: null,
            authenticator: { attachment: 'platform' as const, backedUp: false },
        };
        expect(core.controller.addPasskey(passkey).id).toBe('passkey-new');
        expect(() => core.controller.addPasskey(passkey)).toThrow();
        expect(() => core.controller.addPasskey({ ...passkey, id: 'passkey-x', memberId: 'member-nobody' })).toThrow();
        expect(core.controller.recordPasskeyUse('passkey-new', { at: '2026-10-20T08:00:00Z', backedUp: true })).toBe(
            true,
        );
        expect(core.controller.inspect().passkeys.find(({ id }) => id === 'passkey-new')).toMatchObject({
            lastUsedAt: '2026-10-20T08:00:00Z',
            authenticator: { attachment: 'platform', backedUp: true },
        });
        expect(core.controller.recordPasskeyUse('passkey-owner', { at: AT, backedUp: null })).toBe(true);
        expect(core.controller.recordPasskeyUse('passkey-nobody', { at: AT, backedUp: null })).toBe(false);
    });

    it('records audit entries for the gateway and the host on the same chain', async () => {
        const { core, owner } = team();
        core.controller.recordAudit({
            actor: { kind: 'member', memberId: 'member-owner' },
            action: 'passkey.register',
            target: { kind: 'passkey', id: 'passkey-owner', name: 'Laptop' },
            outcome: 'success',
            client: { ip: '203.0.113.7', userAgent: 'test' },
        });
        core.controller.recordAudit({
            actor: { kind: 'system' },
            action: 'passkey.revoke',
            target: null,
            outcome: 'success',
            client: null,
            details: { passkeys: 1 },
        });
        expect(() => {
            core.controller.recordAudit({
                actor: { kind: 'system' },
                action: 'no.such-action' as never,
                target: null,
                outcome: 'success',
                client: null,
            });
        }).toThrow();
        const items = ok(await owner.audit.list({}, signal())).items;
        expect(items.map(({ action, actor: who, client, details }) => ({ action, who, client, details }))).toEqual([
            { action: 'passkey.revoke', who: { kind: 'system' }, client: null, details: { passkeys: 1 } },
            {
                action: 'passkey.register',
                who: { kind: 'member', memberId: 'member-owner' },
                client: { ip: '203.0.113.7', userAgent: 'test' },
                details: null,
            },
        ]);
        expect(ok(await owner.audit.verify(signal()))).toMatchObject({ status: 'intact', checkedEntries: 2 });
    });

    it('audits nothing a lever does', async () => {
        const { core, owner } = team();
        core.controller.addMember(member('member-z', 'viewer'));
        core.controller.updateEngine({ name: 'Renamed' });
        expect(ok(await owner.audit.list({}, signal())).items).toEqual([]);
        expect(ok(await owner.engine.get(signal())).name).toBe('Renamed');
    });

    it('serves capability routes only when advertised', async () => {
        const { core } = team({ capabilities: [] });
        const result = await core.transport(actor('member-owner', 'session-owner'))(
            ENGINE_API_ROUTES.listRuns,
            {},
            signal(),
        );
        expect(problemOf(result).code).toBe('capability-not-supported');
    });
});

describe('in-memory core: test chat', () => {
    it('paces a test reply and stops generating once the reader aborts', async () => {
        const paced = steppedSleep();
        const { owner } = team({
            sleep: paced.sleep,
            replyScript: () => ({ chunks: [{ text: 'a', delayMs: 10 }, { text: 'b', delayMs: 20 }, 'c'] }),
        });
        const agent = ok(await owner.agents.create({ source: 'Ada' }, signal()));
        const controller = new AbortController();
        const items = ok(
            await owner.testChat.stream(
                agent.id,
                { book: 'Ada', messages: [{ role: 'user', content: 'hi' }] },
                controller.signal,
            ),
        );
        const iterator = items[Symbol.asyncIterator]();
        const first = next(iterator);
        await paced.step();
        expect((await first).event).toEqual({ type: 'delta', seq: 1, text: 'a' });
        const second = iterator.next();
        while (paced.pending().length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        expect(paced.pending()).toEqual([20]);
        controller.abort();
        expect((await second).done).toBe(true);
        expect(paced.pending()).toEqual([]);
    });
});
