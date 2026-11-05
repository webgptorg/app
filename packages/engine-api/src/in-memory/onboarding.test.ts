import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import { AnswerOnboardingBody, OnboardingState } from '../capabilities/onboarding';
import type { OnboardingAnswer } from '../capabilities/onboarding';
import type { EngineApiClient, EngineApiResponse } from '../client';
import { FileId } from '../common';
import { createInMemoryEngine } from '../in-memory-client';
import type { InMemoryEngineApiOptions } from '../in-memory-client';
import { DEVICE_LOGIN_MS } from './onboarding';

const signal = () => AbortSignal.timeout(5_000);
const START = Date.parse('2026-11-05T10:00:00Z');

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`expected ok, got ${response.kind}`);
    return response.data;
}

function code(response: EngineApiResponse<unknown>): string {
    return response.kind === 'problem' ? response.problem.code : 'ok';
}

function setup(options: InMemoryEngineApiOptions = {}) {
    let now = START;
    const engine = createInMemoryEngine({
        clock: { now: () => new Date(now) },
        seed: { onboarding: 'pending' },
        ...options,
    });
    const advance = (ms: number) => {
        now += ms;
    };
    return { ...engine, advance };
}

async function state(client: EngineApiClient): Promise<OnboardingState> {
    return OnboardingState.parse(ok(await client.onboarding.get(signal())));
}

async function answer(client: EngineApiClient, value: OnboardingAnswer): Promise<OnboardingState> {
    const { prompt } = await state(client);
    if (prompt === null) throw new Error('no prompt');
    return ok(await client.onboarding.answer({ promptId: prompt.id, action: 'answer', answer: value }, signal()));
}

describe('onboarding@1 in the reference engine', () => {
    it('asks for the intent, a harness, its device sign-in and files, then is done', async () => {
        const { client, advance } = setup();
        const first = await state(client);
        expect(first).toMatchObject({ status: 'pending', deferred: false, progress: { step: 1, of: 4 } });
        expect(first.prompt).toMatchObject({ kind: 'text', multiline: true, canGoBack: false, initial: '' });

        const harness = await answer(client, {
            kind: 'text',
            text: '  Books for my bakery\n\nkept verbatim',
            fileIds: [],
        });
        expect(harness.prompt).toMatchObject({ kind: 'choice', multiple: false, initial: ['codex'] });

        const login = await answer(client, { kind: 'choice', choiceIds: ['codex'] });
        expect(login.progress).toEqual({ step: 3, of: 4 });
        expect(login.prompt).toMatchObject({
            kind: 'harness-login',
            method: 'device-code',
            status: 'waiting',
            url: 'https://auth.openai.com/codex/device',
        });
        expect(login.prompt?.kind === 'harness-login' && login.prompt.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

        advance(DEVICE_LOGIN_MS - 1);
        expect((await state(client)).prompt?.kind).toBe('harness-login');
        advance(1);
        const files = await state(client);
        expect(files.prompt).toMatchObject({ kind: 'upload', required: false });

        const done = await answer(client, { kind: 'upload', fileIds: [] });
        expect(done).toEqual({ status: 'completed', deferred: false, progress: null, prompt: null });
    });

    it('takes a returned code for a Claude sign-in, and asks again for one that does not look complete', async () => {
        const { client } = setup();
        await answer(client, { kind: 'text', text: '', fileIds: [] });
        const login = await answer(client, { kind: 'choice', choiceIds: ['claude'] });
        expect(login.prompt).toMatchObject({ method: 'return-code', userCode: null, status: 'waiting' });

        const refused = await answer(client, { kind: 'harness-login', returnCode: 'abc' });
        expect(refused.prompt).toMatchObject({ kind: 'harness-login', status: 'waiting' });
        expect(refused.prompt?.error).toMatch(/does not look complete/);

        const next = await answer(client, { kind: 'harness-login', returnCode: 'a1B2c3D4#e5F6' });
        expect(next.prompt?.kind).toBe('upload');
    });

    it('keeps a returned sign-in code out of the audit log, the activity feed and every chat', async () => {
        const { client } = setup();
        await answer(client, { kind: 'text', text: '', fileIds: [] });
        await answer(client, { kind: 'choice', choiceIds: ['claude'] });
        const returnCode = 'q7W9e2R4#t6Y8u0I';
        expect((await answer(client, { kind: 'harness-login', returnCode })).prompt?.kind).toBe('upload');

        const visible = JSON.stringify([
            ok(await client.audit.list({}, signal())),
            ok(await client.activity.list({}, signal())),
            ok(await client.chats.listAll({}, signal())),
            await state(client),
        ]);
        expect(visible).not.toContain(returnCode);
        expect(visible).not.toContain(returnCode.split('#')[0]);
    });

    it('reports a failed or expired sign-in with its reason, and starts it again with a new code', async () => {
        const { client, controller, advance } = setup();
        await answer(client, { kind: 'text', text: 'x', fileIds: [] });
        const first = await answer(client, { kind: 'choice', choiceIds: ['claude'] });
        controller.settleHarnessLogin('denied', 'Your workspace does not allow this sign-in.');
        expect((await state(client)).prompt).toMatchObject({
            status: 'denied',
            diagnostic: 'Your workspace does not allow this sign-in.',
        });
        const retried = await answer(client, { kind: 'harness-login', returnCode: null });
        expect(retried.prompt).toMatchObject({ status: 'waiting', diagnostic: null });
        expect(retried.prompt?.id).not.toBe(first.prompt?.id);

        advance(15 * 60 * 1000);
        expect((await state(client)).prompt).toMatchObject({ status: 'expired' });
        controller.settleHarnessLogin('succeeded');
        expect((await state(client)).prompt?.kind).toBe('upload');
    });

    it('goes back with the draft kept, and refuses Back on the first prompt', async () => {
        const { client } = setup();
        const intent = await state(client);
        expect(
            code(await client.onboarding.answer({ promptId: intent.prompt?.id ?? '', action: 'back' }, signal())),
        ).toBe('validation-failed');
        const harness = await answer(client, { kind: 'text', text: 'My agenda', fileIds: [] });
        const back = ok(
            await client.onboarding.answer({ promptId: harness.prompt?.id ?? '', action: 'back' }, signal()),
        );
        expect(back.prompt).toMatchObject({ kind: 'text', initial: 'My agenda' });
    });

    it('refuses an answer to a prompt it moved past, and an answer of another kind, changing nothing', async () => {
        const { client } = setup();
        const intent = await state(client);
        await answer(client, { kind: 'text', text: 'x', fileIds: [] });
        const stale = await client.onboarding.answer(
            { promptId: intent.prompt?.id ?? '', action: 'answer', answer: { kind: 'text', text: 'y', fileIds: [] } },
            signal(),
        );
        expect(code(stale)).toBe('onboarding-prompt-stale');
        const current = await state(client);
        const wrongKind = await client.onboarding.answer(
            { promptId: current.prompt?.id ?? '', action: 'answer', answer: { kind: 'confirm', confirmed: true } },
            signal(),
        );
        expect(code(wrongKind)).toBe('validation-failed');
        expect(await state(client)).toEqual(current);
    });

    it('asks again for files it does not have, and for one tool', async () => {
        const { client } = setup();
        const missing = await answer(client, { kind: 'text', text: 'x', fileIds: [FileId.parse('file-nope')] });
        expect(missing.prompt).toMatchObject({ kind: 'text', error: 'A file is missing.' });
        await answer(client, { kind: 'text', text: 'x', fileIds: [] });
        const both = await answer(client, { kind: 'choice', choiceIds: ['codex', 'claude'] });
        expect(both.prompt).toMatchObject({ kind: 'choice', error: 'Choose one tool.' });
    });

    it('stays pending and reachable when skipped for now', async () => {
        const { client } = setup();
        const deferred = ok(await client.onboarding.defer(signal()));
        expect(deferred).toMatchObject({ status: 'pending', deferred: true });
        expect((await answer(client, { kind: 'text', text: 'x', fileIds: [] })).deferred).toBe(true);
    });

    it('has three steps without files@1, and none of its routes without onboarding@1', async () => {
        const { client } = setup({ capabilities: [KNOWN_CAPABILITIES.onboarding] });
        expect((await state(client)).progress).toEqual({ step: 1, of: 3 });
        const bare = setup({ capabilities: [KNOWN_CAPABILITIES.files] }).client;
        expect(code(await bare.onboarding.get(signal()))).toBe('capability-not-supported');
        expect(code(await bare.onboarding.defer(signal()))).toBe('capability-not-supported');
    });

    it('is completed by default, and needs settings.manage', async () => {
        const done = createInMemoryEngine().client;
        expect(await state(done)).toMatchObject({ status: 'completed', prompt: null });
        const member = setup({ member: { id: 'member-ada', role: 'member', permissions: ['agents.read'] } }).client;
        expect(code(await member.onboarding.get(signal()))).toBe('forbidden');
    });

    it('accepts only an answer with action answer, and no answer with back', () => {
        expect(AnswerOnboardingBody.safeParse({ promptId: 'p', action: 'answer' }).success).toBe(false);
        expect(
            AnswerOnboardingBody.safeParse({
                promptId: 'p',
                action: 'back',
                answer: { kind: 'confirm', confirmed: true },
            }).success,
        ).toBe(false);
        expect(
            AnswerOnboardingBody.safeParse({
                promptId: 'p',
                action: 'answer',
                answer: { kind: 'harness-login', returnCode: null, extra: 1 },
            }).success,
        ).toBe(false);
    });
});
