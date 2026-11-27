import { describe, expect, it } from 'vitest';

import { AiTool, AiToolSignIn } from '../capabilities/ai-tools';
import type { ReadAiToolSignIn } from '../capabilities/ai-tools';
import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import { createEngineApiClient } from '../client';
import type { EngineApiClient, EngineApiResponse } from '../client';
import { AiToolId } from '../common';
import { DEFAULT_CAPABILITIES, actorFromOptions, createInMemoryEngineCore } from '../in-memory-client';
import type { InMemoryEngineApiOptions } from '../in-memory-client';
import { OWNER_PERMISSIONS } from '../permissions';
import type { Permission } from '../permissions';
import { withClientReading } from '../reader';
import { AI_TOOL_DEVICE_LOGIN_MS, AI_TOOL_SIGN_IN_TTL_MS } from './ai-tools';

const signal = () => AbortSignal.timeout(5_000);
const START = Date.parse('2026-11-24T09:00:00Z');
const CLAUDE = AiToolId.parse('claude-code');
const CODEX = AiToolId.parse('codex');
const GEMINI = AiToolId.parse('gemini-cli');
const ANTHROPIC_KEY = 'sk-ant-test-not-a-real-key-0000000000';

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function codeOf(response: EngineApiResponse<unknown>): string {
    return response.kind === 'problem' ? response.problem.code : 'ok';
}

function setup(options: Pick<InMemoryEngineApiOptions, 'capabilities'> = {}) {
    let now = START;
    const core = createInMemoryEngineCore({ clock: { now: () => new Date(now) }, ...options });
    const clientAs = (
        actor: {
            readonly permissions?: readonly Permission[];
            readonly session?: string;
            readonly stepUp?: 'satisfied' | 'required';
        } = {},
    ): EngineApiClient =>
        createEngineApiClient(
            withClientReading(
                core.transport({
                    ...actorFromOptions({
                        member: { permissions: actor.permissions ?? OWNER_PERMISSIONS },
                        ...(actor.stepUp === undefined ? {} : { stepUp: actor.stepUp }),
                    }),
                    ...(actor.session === undefined ? {} : { sessionId: actor.session as never }),
                }),
            ),
        );
    return {
        core,
        controller: core.controller,
        owner: clientAs(),
        clientAs,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

async function tool(client: EngineApiClient, id: AiToolId) {
    return AiTool.parse(ok(await client.aiTools.get(id, signal())));
}

function promptOf(signIn: ReadAiToolSignIn) {
    if (signIn.prompt === null || signIn.prompt.kind === 'unsupported') throw new Error('no prompt');
    return signIn.prompt;
}

async function answerSecret(client: EngineApiClient, signIn: ReadAiToolSignIn, value: string) {
    return ok(
        await client.aiTools.answerSignIn(
            signIn.aiToolId,
            signIn.id,
            { promptId: promptOf(signIn).id, action: 'answer', answer: { kind: 'secret', value } },
            signal(),
        ),
    );
}

async function answerCode(client: EngineApiClient, signIn: ReadAiToolSignIn, returnCode: string | null) {
    return ok(
        await client.aiTools.answerSignIn(
            signIn.aiToolId,
            signIn.id,
            { promptId: promptOf(signIn).id, action: 'answer', answer: { kind: 'harness-login', returnCode } },
            signal(),
        ),
    );
}

describe('ai-tools@1 in the in-memory engine', () => {
    it('lists its tools with strict shapes: signed in by account, by key, and one not installed', async () => {
        const { owner } = setup();
        const { items } = ok(await owner.aiTools.list(signal()));
        expect(items.map((item) => AiTool.parse(item))).toMatchObject([
            { id: CLAUDE, status: 'signed-in', auth: { method: 'account', account: 'Claude Max' }, problem: null },
            { id: CODEX, status: 'signed-in', auth: { method: 'api-key', account: null } },
            { id: GEMINI, status: 'not-installed', auth: null, signInMethods: [], problem: { code: 'not-installed' } },
        ]);
        expect(codeOf(await owner.aiTools.get(AiToolId.parse('nope'), signal()))).toBe('not-found');
    });

    it('is not there without the capability', async () => {
        const { owner } = setup({
            capabilities: DEFAULT_CAPABILITIES.filter((ref) => ref !== KNOWN_CAPABILITIES.aiTools),
        });
        expect(codeOf(await owner.aiTools.list(signal()))).toBe('capability-not-supported');
    });

    it('checks a tool now and announces the change to readers only', async () => {
        const { owner, advance, controller } = setup();
        const events: string[] = [];
        controller.onEvent((event) => events.push(event.type));
        advance(60_000);
        const checked = AiTool.parse(ok(await owner.aiTools.check(CLAUDE, signal())));
        expect(checked).toMatchObject({
            status: 'signed-in',
            checking: false,
            checkedAt: new Date(START + 60_000).toISOString(),
        });
        expect(events).toEqual(['ai-tool.changed']);
        expect(codeOf(await owner.aiTools.check(GEMINI, signal()))).toBe('ai-tool-not-installed');
    });

    it('reports a failing check as an error, and an expired sign-in as needing one', async () => {
        const { owner, controller } = setup();
        controller.failAiToolCheck(CODEX, { code: 'quota-exceeded', message: 'You exceeded your current quota.' });
        expect(AiTool.parse(ok(await owner.aiTools.check(CODEX, signal())))).toMatchObject({
            status: 'error',
            problem: { code: 'quota-exceeded', message: 'You exceeded your current quota.' },
        });
        controller.failAiToolCheck(CODEX, null);
        expect(ok(await owner.aiTools.check(CODEX, signal())).status).toBe('signed-in');

        controller.failAiToolCheck(CLAUDE, { code: 'sign-in-expired', message: 'OAuth session expired.' });
        expect(AiTool.parse(ok(await owner.aiTools.check(CLAUDE, signal())))).toMatchObject({
            status: 'needs-sign-in',
            auth: { method: 'account' },
            problem: { code: 'sign-in-expired' },
        });
        expect(() => {
            controller.failAiToolCheck('nope', null);
        }).toThrow();
    });

    it('fails a chat turn while the tool chats run on needs a sign-in, naming it in the recheck', async () => {
        const { owner, controller } = setup();
        const agent = ok(await owner.agents.create({ source: 'Ada' }, signal()));
        const chat = ok(await owner.chats.create({ agentId: agent.id, title: 'Tools' }, signal()));
        expect(controller.expireAiToolSignIn(CLAUDE).status).toBe('needs-sign-in');
        ok(await owner.chats.sendMessage(chat.id, { content: 'Hello' }, signal()));
        const read = ok(await owner.chats.get(chat.id, signal()));
        expect(read.working).toEqual([]);
        expect(read.recheck).toMatchObject({ aiToolId: CLAUDE, rounds: 1 });
        expect(read.recheck?.cause).toContain('Claude Code');
        expect(() => controller.expireAiToolSignIn(GEMINI)).toThrow();
        expect(() => controller.renewAiToolSignIn(GEMINI)).toThrow();
        expect(controller.renewAiToolSignIn(CLAUDE).status).toBe('signed-in');
        ok(await owner.chats.sendMessage(chat.id, { content: 'Again' }, signal()));
        expect(ok(await owner.chats.get(chat.id, signal())).working).toHaveLength(1);
        ok(await owner.aiTools.signOut(CLAUDE, signal()));
        expect(controller.renewAiToolSignIn(CLAUDE).auth).toEqual({ method: 'account', account: 'Claude Max' });
    });

    it('carries the tool of a failed turn and of a seeded recheck', async () => {
        const core = createInMemoryEngineCore({
            seed: {
                agents: [{ source: 'Ada', id: 'agent-ada' }],
                chats: [
                    {
                        id: 'chat-seeded',
                        createdAt: new Date(START).toISOString(),
                        entries: [
                            { type: 'message', author: { kind: 'user', key: 'user' }, content: 'Hi' },
                            { type: 'joined', participant: { kind: 'agent', key: 'agent-ada' } },
                        ],
                        recheck: {
                            cause: 'Gemini CLI needs signing in.',
                            nextAt: new Date(START + 60_000).toISOString(),
                            rounds: 1,
                            author: { kind: 'agent', key: 'agent-ada' },
                            aiToolId: 'gemini-cli',
                        },
                    },
                ],
            },
        });
        const owner = createEngineApiClient(withClientReading(core.transport(actorFromOptions({}))));
        expect(ok(await owner.chats.get('chat-seeded' as never, signal())).recheck?.aiToolId).toBe(GEMINI);
        const agent = ok(await owner.agents.create({ source: 'Bob' }, signal()));
        const chat = ok(await owner.chats.create({ agentId: agent.id }, signal()));
        core.controller.startReplyTurn(chat.id, agent.id, 'Hi');
        const failed = core.controller.failReplyTurn(chat.id, agent.id, 'Codex needs signing in.', 'codex');
        expect(failed.recheck).toMatchObject({ aiToolId: CODEX, cause: 'Codex needs signing in.' });
        core.controller.recheckChat(chat.id);
        const plain = core.controller.failReplyTurn(chat.id, agent.id);
        expect(plain.recheck?.aiToolId).toBeNull();
    });

    it('signs Claude Code in again with a returned code, verified before it replaces anything', async () => {
        const { owner, controller } = setup();
        controller.expireAiToolSignIn(CLAUDE);
        const started = ok(await owner.aiTools.startSignIn(CLAUDE, { method: 'account' }, signal()));
        AiToolSignIn.parse(started);
        const login = promptOf(started);
        expect(started).toMatchObject({ status: 'pending', method: 'account' });
        expect(login).toMatchObject({
            kind: 'harness-login',
            method: 'return-code',
            status: 'waiting',
            canGoBack: false,
        });

        const refused = await answerCode(owner, started, 'abc');
        expect(promptOf(refused).error).toContain('does not look complete');
        expect(promptOf(refused).id).not.toBe(login.id);
        expect(
            codeOf(
                await owner.aiTools.answerSignIn(
                    CLAUDE,
                    started.id,
                    { promptId: login.id, action: 'answer', answer: { kind: 'harness-login', returnCode: 'abcdef' } },
                    signal(),
                ),
            ),
        ).toBe('ai-tool-sign-in-stale');

        const done = await answerCode(owner, refused, 'code#123456');
        expect(done).toMatchObject({ status: 'completed', prompt: null, tool: { status: 'signed-in' } });
        expect((await tool(owner, CLAUDE)).problem).toBeNull();
        expect(
            codeOf(
                await owner.aiTools.answerSignIn(
                    CLAUDE,
                    started.id,
                    { promptId: 'any', action: 'answer', answer: { kind: 'harness-login', returnCode: 'abcdef' } },
                    signal(),
                ),
            ),
        ).toBe('ai-tool-sign-in-stale');
        const audit = ok(await owner.audit.list({}, signal())).items.map(({ action, outcome }) => [action, outcome]);
        expect(audit).toEqual(
            expect.arrayContaining([
                ['ai-tool.sign-in.start', 'success'],
                ['ai-tool.sign-in.complete', 'success'],
            ]),
        );
    });

    it('takes an API key instead, refuses a wrong one, and never sends, audits or announces the key', async () => {
        const { owner, controller } = setup();
        const seen: string[] = [];
        controller.onEvent((event) => seen.push(JSON.stringify(event)));
        const started = ok(await owner.aiTools.startSignIn(CLAUDE, { method: 'account' }, signal()));
        expect(promptOf(started).alternatives.map(({ id }) => id)).toEqual(['api-key']);
        const asKey = ok(
            await owner.aiTools.answerSignIn(
                CLAUDE,
                started.id,
                { promptId: promptOf(started).id, action: 'alternative', alternativeId: 'api-key' },
                signal(),
            ),
        );
        expect(asKey.method).toBe('api-key');
        expect(promptOf(asKey)).toMatchObject({
            kind: 'secret',
            label: 'Anthropic API key',
            helpUrl: 'https://console.anthropic.com/settings/keys',
            error: null,
        });

        const wrong = await answerSecret(owner, asKey, 'sk-ant-short');
        expect(promptOf(wrong).error).toContain('did not accept');
        const done = await answerSecret(owner, wrong, ANTHROPIC_KEY);
        expect(done).toMatchObject({ status: 'completed', tool: { auth: { method: 'api-key', account: null } } });

        const everything = JSON.stringify([
            wrong,
            done,
            ok(await owner.aiTools.list(signal())),
            ok(await owner.audit.list({}, signal())),
            seen,
        ]);
        expect(everything).not.toContain(ANTHROPIC_KEY);
        expect(everything).not.toContain('sk-ant-short');
    });

    it('switches back from a key to the account sign-in and refuses alternatives it does not offer', async () => {
        const { owner } = setup();
        const started = ok(await owner.aiTools.startSignIn(CODEX, { method: 'api-key' }, signal()));
        expect(promptOf(started).alternatives.map(({ id }) => id)).toEqual(['account']);
        expect(
            codeOf(
                await owner.aiTools.answerSignIn(
                    CODEX,
                    started.id,
                    { promptId: promptOf(started).id, action: 'alternative', alternativeId: 'terminal' },
                    signal(),
                ),
            ),
        ).toBe('validation-failed');
        expect(
            codeOf(
                await owner.aiTools.answerSignIn(
                    CODEX,
                    started.id,
                    {
                        promptId: promptOf(started).id,
                        action: 'answer',
                        answer: { kind: 'harness-login', returnCode: null },
                    },
                    signal(),
                ),
            ),
        ).toBe('validation-failed');
        const login = ok(
            await owner.aiTools.answerSignIn(
                CODEX,
                started.id,
                { promptId: promptOf(started).id, action: 'alternative', alternativeId: 'account' },
                signal(),
            ),
        );
        expect(promptOf(login)).toMatchObject({ kind: 'harness-login', method: 'device-code', status: 'waiting' });
        const device = promptOf(login);
        expect(device.kind === 'harness-login' ? device.userCode : null).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });

    it('completes a Codex device login when the provider confirms it, and retries a failed one', async () => {
        const { owner, controller, advance } = setup();
        const started = ok(await owner.aiTools.startSignIn(CODEX, { method: 'account' }, signal()));
        const typed = await answerCode(owner, started, 'K7QF-3MRP');
        expect(promptOf(typed).error).toContain('needs no code');

        controller.settleAiToolSignIn(CODEX, 'denied', 'The device code was denied.');
        const denied = ok(await owner.aiTools.getSignIn(CODEX, started.id, signal()));
        expect(promptOf(denied)).toMatchObject({ status: 'denied', diagnostic: 'The device code was denied.' });
        expect(() => {
            controller.settleAiToolSignIn(CODEX, 'succeeded');
        }).toThrow();

        const again = await answerCode(owner, denied, null);
        expect(promptOf(again)).toMatchObject({ status: 'waiting' });
        advance(AI_TOOL_DEVICE_LOGIN_MS);
        const done = ok(await owner.aiTools.getSignIn(CODEX, started.id, signal()));
        expect(done).toMatchObject({
            status: 'completed',
            tool: { auth: { method: 'account', account: 'ChatGPT Plus' } },
        });

        const second = ok(await owner.aiTools.startSignIn(CODEX, { method: 'account' }, signal()));
        controller.settleAiToolSignIn(CODEX, 'succeeded');
        expect(ok(await owner.aiTools.getSignIn(CODEX, second.id, signal())).status).toBe('completed');
        expect(() => {
            controller.settleAiToolSignIn(CODEX, 'failed');
        }).toThrow();
    });

    it('keeps the old credentials when the provider refuses the new ones', async () => {
        const { owner, controller } = setup();
        controller.failAiToolCheck(CLAUDE, { code: 'key-rejected', message: 'Invalid x-api-key.' });
        const asKey = ok(await owner.aiTools.startSignIn(CLAUDE, { method: 'api-key' }, signal()));
        const refused = await answerSecret(owner, asKey, ANTHROPIC_KEY);
        expect(refused.status).toBe('pending');
        expect(promptOf(refused).error).toBe('Invalid x-api-key.');
        const login = ok(await owner.aiTools.startSignIn(CLAUDE, { method: 'account' }, signal()));
        const failed = await answerCode(owner, login, 'code-123456');
        expect(promptOf(failed)).toMatchObject({ status: 'failed', diagnostic: 'Invalid x-api-key.' });
        expect((await tool(owner, CLAUDE)).auth).toEqual({ method: 'account', account: 'Claude Max' });
    });

    it('binds a sign-in to its session, forgets it when cancelled, replaced or expired', async () => {
        const { owner, clientAs, advance } = setup();
        const started = ok(await owner.aiTools.startSignIn(CLAUDE, { method: 'account' }, signal()));
        const laptop = clientAs({ session: 'session-laptop' });
        expect(codeOf(await laptop.aiTools.getSignIn(CLAUDE, started.id, signal()))).toBe('not-found');
        expect(codeOf(await laptop.aiTools.cancelSignIn(CLAUDE, started.id, signal()))).toBe('not-found');
        expect(codeOf(await owner.aiTools.getSignIn(CODEX, started.id, signal()))).toBe('not-found');

        const replaced = ok(await owner.aiTools.startSignIn(CLAUDE, { method: 'api-key' }, signal()));
        expect(codeOf(await owner.aiTools.getSignIn(CLAUDE, started.id, signal()))).toBe('not-found');
        ok(await owner.aiTools.cancelSignIn(CLAUDE, replaced.id, signal()));
        expect(
            codeOf(
                await owner.aiTools.answerSignIn(
                    CLAUDE,
                    replaced.id,
                    { promptId: 'p', action: 'answer', answer: { kind: 'secret', value: ANTHROPIC_KEY } },
                    signal(),
                ),
            ),
        ).toBe('not-found');

        const late = ok(await owner.aiTools.startSignIn(CLAUDE, { method: 'account' }, signal()));
        advance(AI_TOOL_SIGN_IN_TTL_MS);
        expect(codeOf(await owner.aiTools.getSignIn(CLAUDE, late.id, signal()))).toBe('not-found');
    });

    it('signs a tool out, idempotently, and refuses tools that are not installed', async () => {
        const { owner } = setup();
        const out = AiTool.parse(ok(await owner.aiTools.signOut(CODEX, signal())));
        expect(out).toMatchObject({ status: 'needs-sign-in', auth: null, problem: { code: 'not-signed-in' } });
        expect(ok(await owner.aiTools.signOut(CODEX, signal()))).toEqual(out);
        expect(codeOf(await owner.aiTools.signOut(GEMINI, signal()))).toBe('ai-tool-not-installed');
        expect(codeOf(await owner.aiTools.startSignIn(GEMINI, { method: 'account' }, signal()))).toBe(
            'ai-tool-not-installed',
        );
        expect(codeOf(await owner.aiTools.signOut(AiToolId.parse('nope'), signal()))).toBe('not-found');
        const audit = ok(await owner.audit.list({}, signal())).items.filter(
            ({ action, outcome }) => action === 'ai-tool.sign-out' && outcome === 'success',
        );
        expect(audit[0]).toMatchObject({ target: { kind: 'ai-tool', id: 'codex', name: 'OpenAI Codex' } });
    });

    it('lets readers see and check, and keeps sign-in, keys and sign-out to ai-tools.manage behind step-up', async () => {
        const { clientAs } = setup();
        const admin = clientAs({ permissions: OWNER_PERMISSIONS.filter((p) => p !== 'ai-tools.manage') });
        ok(await admin.aiTools.list(signal()));
        ok(await admin.aiTools.check(CLAUDE, signal()));
        const refused = await admin.aiTools.startSignIn(CLAUDE, { method: 'api-key' }, signal());
        expect(refused.kind === 'problem' && refused.problem).toMatchObject({
            code: 'forbidden',
            requiredPermission: 'ai-tools.manage',
        });
        expect(codeOf(await admin.aiTools.signOut(CLAUDE, signal()))).toBe('forbidden');
        expect(codeOf(await admin.aiTools.getSignIn(CLAUDE, AiToolId.parse('x') as never, signal()))).toBe('forbidden');

        const member = clientAs({ permissions: ['agents.read', 'chats.read'] });
        expect(codeOf(await member.aiTools.list(signal()))).toBe('forbidden');
        expect(codeOf(await member.aiTools.check(CLAUDE, signal()))).toBe('forbidden');

        const stale = clientAs({ stepUp: 'required' });
        expect(codeOf(await stale.aiTools.startSignIn(CLAUDE, { method: 'account' }, signal()))).toBe(
            'step-up-required',
        );
        expect(codeOf(await stale.aiTools.signOut(CLAUDE, signal()))).toBe('step-up-required');
    });
});
