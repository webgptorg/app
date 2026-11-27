import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import { AnswerOnboardingBody, OnboardingState, OnboardingStateReader } from '../capabilities/onboarding';
import type { OnboardingAnswer, ReadOnboardingState } from '../capabilities/onboarding';
import type { EngineApiClient, EngineApiResponse } from '../client';
import { FileId } from '../common';
import { createInMemoryEngine } from '../in-memory-client';
import type { InMemoryEngineApiOptions } from '../in-memory-client';
import { CHECK_MS, CREATE_MS, DEVICE_LOGIN_MS, INSTALL_MS } from './onboarding';

const signal = () => AbortSignal.timeout(5_000);
const START = Date.parse('2026-11-05T10:00:00Z');
const API_KEY = 'sk-proj-Q8wErTy7uIoP2aSdFgH4jKlZ';

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

async function state(client: EngineApiClient): Promise<ReadOnboardingState> {
    const read = ok(await client.onboarding.get(signal()));
    // The reference engine must answer the strict schema, not only what a tolerant client accepts.
    OnboardingState.parse(read);
    return read;
}

function errorOf(read: ReadOnboardingState): string | null {
    return read.prompt === null || read.prompt.kind === 'unsupported' ? null : read.prompt.error;
}

async function promptId(client: EngineApiClient): Promise<string> {
    const { prompt } = await state(client);
    if (prompt === null) throw new Error('no prompt');
    return prompt.id;
}

async function answer(client: EngineApiClient, value: OnboardingAnswer): Promise<ReadOnboardingState> {
    const id = await promptId(client);
    return ok(await client.onboarding.answer({ promptId: id, action: 'answer', answer: value }, signal()));
}

async function back(client: EngineApiClient): Promise<ReadOnboardingState> {
    return ok(await client.onboarding.answer({ promptId: await promptId(client), action: 'back' }, signal()));
}

async function alternative(client: EngineApiClient, alternativeId: string) {
    return client.onboarding.answer(
        { promptId: await promptId(client), action: 'alternative', alternativeId },
        signal(),
    );
}

/** Through the brief and the choice of one tool to its sign-in. */
async function toSignIn(client: EngineApiClient, advance: (ms: number) => void, harness: 'codex' | 'claude') {
    await answer(client, { kind: 'text', text: 'Books for my bakery', fileIds: [] });
    await answer(client, { kind: 'choice', choiceIds: [harness] });
    if (harness === 'codex') advance(INSTALL_MS);
    return state(client);
}

describe('onboarding@1 in the reference engine', () => {
    it('walks a new engine from the brief through two tools, one failing, to a created project', async () => {
        const { client, controller, advance } = setup({ seed: { onboarding: 'no-project' } });
        const upload = await controller.addFile({
            name: 'notes.md',
            contentType: 'text/markdown',
            content: new Blob(['# Notes']),
            purpose: 'upload',
            createdBy: 'member-owner',
        });

        const intent = await state(client);
        expect(intent).toMatchObject({
            status: 'pending',
            deferred: false,
            canDefer: false,
            progress: { step: 1, of: 6 },
            activity: [],
        });
        expect(intent.prompt).toMatchObject({ kind: 'text', multiline: true, attachments: true, canGoBack: false });
        expect(code(await client.onboarding.defer(signal()))).toBe('onboarding-not-deferrable');
        expect(await state(client)).toEqual(intent);

        const harnesses = await answer(client, {
            kind: 'text',
            text: 'Books for my bakery\n\nkept verbatim',
            fileIds: [upload.id],
        });
        expect(harnesses.prompt).toMatchObject({ kind: 'choice', multiple: true, initial: ['codex'] });

        const installing = await answer(client, { kind: 'choice', choiceIds: ['codex', 'claude', 'codex'] });
        expect(installing).toMatchObject({ status: 'working', prompt: null, progress: { step: 3, of: 6 } });
        expect(installing.activity).toEqual([
            { id: 'install-codex', label: 'Install OpenAI Codex', status: 'running', detail: null },
        ]);

        advance(INSTALL_MS - 1);
        expect((await state(client)).status).toBe('working');
        advance(1);
        const codex = await state(client);
        expect(codex.prompt).toMatchObject({
            kind: 'harness-login',
            method: 'device-code',
            status: 'waiting',
            url: 'https://auth.openai.com/codex/device',
            alternatives: [
                { id: 'api-key', href: null },
                { id: 'terminal', href: '/_ptbk/harness-terminal' },
            ],
        });
        expect(codex.prompt?.kind === 'harness-login' && codex.prompt.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
        expect(codex.activity.map(({ status }) => status)).toEqual(['done']);

        controller.failHarnessCheck('claude', 'Claude Code answered: this account has no access to Claude Code.');
        advance(DEVICE_LOGIN_MS);
        expect(await state(client)).toMatchObject({ status: 'working', prompt: null });
        advance(CHECK_MS);
        const claude = await state(client);
        expect(claude.prompt).toMatchObject({
            kind: 'harness-login',
            method: 'return-code',
            userCode: null,
            alternatives: [{ id: 'terminal' }],
        });
        expect(claude.activity).toEqual([
            { id: 'install-codex', label: 'Install OpenAI Codex', status: 'done', detail: null },
            { id: 'check-codex', label: 'Check OpenAI Codex', status: 'done', detail: null },
            {
                id: 'install-claude',
                label: 'Install Claude Code',
                status: 'skipped',
                detail: 'Already installed on this engine.',
            },
        ]);

        await answer(client, { kind: 'harness-login', returnCode: 'a1B2c3D4#e5F6' });
        advance(CHECK_MS);
        const title = await state(client);
        expect(title).toMatchObject({ status: 'pending', progress: { step: 4, of: 6 } });
        expect(title.prompt).toMatchObject({ kind: 'text', multiline: false, initial: 'Books for my bakery' });
        expect(title.activity.at(-1)).toEqual({
            id: 'check-claude',
            label: 'Check Claude Code',
            status: 'failed',
            detail: 'Claude Code answered: this account has no access to Claude Code.',
        });

        const folder = await answer(client, { kind: 'text', text: '  Bakery   books ', fileIds: [] });
        expect(folder.prompt).toMatchObject({ kind: 'text', initial: 'bakery-books' });
        const refused = await answer(client, { kind: 'text', text: 'Bakery Books', fileIds: [] });
        expect(refused.prompt?.kind === 'text' && refused.prompt.error).toMatch(/lowercase/);

        const review = await answer(client, { kind: 'text', text: 'bakery', fileIds: [] });
        expect(review.prompt).toMatchObject({
            kind: 'confirm',
            question: 'Create Bakery books in bakery and start its agenda?',
            details: [
                { label: 'Project', text: 'Bakery books' },
                { label: 'Folder', text: 'bakery' },
                { label: 'AI tools', text: 'OpenAI Codex' },
                { label: 'Brief', text: 'Books for my bakery kept verbatim' },
                { label: 'Files', text: '1 attached' },
            ],
        });

        const creating = await answer(client, { kind: 'confirm', confirmed: true });
        expect(creating).toMatchObject({ status: 'working', canDefer: false, progress: { step: 6, of: 6 } });
        expect(creating.activity).toEqual([
            { id: 'create-project', label: 'Create Bakery books', status: 'running', detail: null },
        ]);
        expect(controller.onboarding()).toMatchObject({ status: 'working', canDefer: false });
        advance(CREATE_MS);
        expect(controller.onboarding()).toMatchObject({ status: 'completed', canDefer: true });
        expect(await state(client)).toEqual({
            status: 'completed',
            deferred: false,
            canDefer: true,
            progress: null,
            activity: [{ id: 'create-project', label: 'Create Bakery books', status: 'done', detail: null }],
            prompt: null,
        });
        expect(ok(await client.onboarding.defer(signal())).deferred).toBe(false);
    });

    it('goes back step by step with the drafts kept, and refuses Back on the first prompt', async () => {
        const { client, advance } = setup();
        const first = await client.onboarding.answer({ promptId: await promptId(client), action: 'back' }, signal());
        expect(code(first)).toBe('validation-failed');
        await answer(client, { kind: 'text', text: 'My agenda', fileIds: [] });
        await answer(client, { kind: 'choice', choiceIds: ['claude'] });
        await answer(client, { kind: 'harness-login', returnCode: 'a1B2c3D4e5' });
        advance(CHECK_MS);
        await answer(client, { kind: 'text', text: 'Agenda', fileIds: [] });
        await answer(client, { kind: 'text', text: 'agenda-2', fileIds: [] });
        expect((await state(client)).prompt?.kind).toBe('confirm');

        expect((await back(client)).prompt).toMatchObject({ title: 'Project folder', initial: 'agenda-2' });
        expect((await back(client)).prompt).toMatchObject({ title: 'Project name', initial: 'Agenda' });
        const same = await answer(client, { kind: 'text', text: 'Agenda', fileIds: [] });
        expect(same.prompt).toMatchObject({ initial: 'agenda-2' });
        await back(client);
        const harnesses = await back(client);
        expect(harnesses).toMatchObject({ activity: [], prompt: { kind: 'choice', initial: ['claude'] } });
        expect((await back(client)).prompt).toMatchObject({ kind: 'text', initial: 'My agenda' });
    });

    it('goes back from a sign-in to the tools, and from the API key to a new device code', async () => {
        const { client, advance } = setup();
        const first = await toSignIn(client, advance, 'codex');
        expect(ok(await alternative(client, 'api-key')).prompt?.kind).toBe('secret');
        const again = await back(client);
        expect(again.prompt).toMatchObject({ kind: 'harness-login', status: 'waiting' });
        expect(again.prompt?.kind === 'harness-login' && again.prompt.userCode).not.toBe(
            first.prompt?.kind === 'harness-login' && first.prompt.userCode,
        );
        expect((await back(client)).prompt?.kind).toBe('choice');
    });

    it('takes an API key instead of the device code, refusing one the provider would not, and keeps none of it', async () => {
        const { client, controller, advance } = setup();
        await toSignIn(client, advance, 'codex');
        const secret = ok(await alternative(client, 'api-key'));
        expect(secret.prompt).toMatchObject({
            kind: 'secret',
            label: 'OpenAI API key',
            helpUrl: 'https://platform.openai.com/api-keys',
            canGoBack: true,
        });
        expect(secret.prompt).not.toHaveProperty('initial');

        const wrongKey = 'sk-not-quite-a-key';
        const refused = await answer(client, { kind: 'secret', value: wrongKey });
        expect(refused.prompt?.kind).toBe('secret');
        expect(errorOf(refused)).toMatch(/did not accept/);
        expect(refused.prompt?.id).not.toBe(secret.prompt?.id);
        expect(JSON.stringify(refused)).not.toContain(wrongKey);

        expect(await answer(client, { kind: 'secret', value: API_KEY })).toMatchObject({ status: 'working' });
        advance(CHECK_MS);
        await answer(client, { kind: 'text', text: 'Bakery', fileIds: [] });
        await answer(client, { kind: 'text', text: 'bakery', fileIds: [] });

        const visible = JSON.stringify([
            await state(client),
            controller.inspect(),
            ok(await client.audit.list({}, signal())),
            ok(await client.activity.list({}, signal())),
            ok(await client.chats.listAll({}, signal())),
        ]);
        for (const value of [wrongKey, API_KEY, API_KEY.slice(3, 15)]) expect(visible).not.toContain(value);
    });

    it('refuses an alternative the prompt does not offer, and one that is a link', async () => {
        const { client, advance } = setup();
        expect(code(await alternative(client, 'api-key'))).toBe('validation-failed');
        await toSignIn(client, advance, 'codex');
        const before = await state(client);
        expect(code(await alternative(client, 'terminal'))).toBe('validation-failed');
        expect(code(await alternative(client, 'phone'))).toBe('validation-failed');
        expect(await state(client)).toEqual(before);
    });

    it('takes a returned code for a Claude sign-in, and asks again for one that does not look complete', async () => {
        const { client, advance } = setup();
        const login = await toSignIn(client, advance, 'claude');
        expect(login.prompt).toMatchObject({ method: 'return-code', userCode: null, status: 'waiting' });
        const refused = await answer(client, { kind: 'harness-login', returnCode: 'abc' });
        expect(refused.prompt).toMatchObject({ kind: 'harness-login', status: 'waiting' });
        expect(refused.prompt?.kind === 'harness-login' && refused.prompt.error).toMatch(/does not look complete/);
        expect(await answer(client, { kind: 'harness-login', returnCode: 'a1B2c3D4#e5F6' })).toMatchObject({
            status: 'working',
        });
    });

    it('needs no code back for a device sign-in', async () => {
        const { client, advance } = setup();
        await toSignIn(client, advance, 'codex');
        const refused = await answer(client, { kind: 'harness-login', returnCode: 'a1B2c3D4' });
        expect(refused.prompt?.kind === 'harness-login' && refused.prompt.error).toMatch(/needs no code/);
    });

    it('keeps a returned sign-in code out of the audit log, the activity feed and every chat', async () => {
        const { client, advance } = setup();
        await toSignIn(client, advance, 'claude');
        const returnCode = 'q7W9e2R4#t6Y8u0I';
        await answer(client, { kind: 'harness-login', returnCode });
        const visible = JSON.stringify([
            ok(await client.audit.list({}, signal())),
            ok(await client.activity.list({}, signal())),
            ok(await client.chats.listAll({}, signal())),
            await state(client),
        ]);
        expect(visible).not.toContain(returnCode);
        expect(visible).not.toContain(returnCode.split('#')[0]);
    });

    it('reports a failed or expired sign-in with its reason, and starts it again', async () => {
        const { client, controller, advance } = setup();
        const first = await toSignIn(client, advance, 'claude');
        controller.settleHarnessLogin('denied', 'Your workspace does not allow this sign-in.');
        expect((await state(client)).prompt).toMatchObject({
            status: 'denied',
            diagnostic: 'Your workspace does not allow this sign-in.',
        });
        const restarted = await answer(client, { kind: 'harness-login', returnCode: 'a1B2c3D4e5' });
        expect(restarted.prompt).toMatchObject({ status: 'waiting', diagnostic: null });
        controller.settleHarnessLogin('failed');
        const retried = await answer(client, { kind: 'harness-login', returnCode: null });
        expect(retried.prompt).toMatchObject({ status: 'waiting', diagnostic: null });
        expect(retried.prompt?.id).not.toBe(first.prompt?.id);

        advance(15 * 60 * 1000);
        expect((await state(client)).prompt).toMatchObject({
            status: 'expired',
            diagnostic: 'The sign-in expired. Start it again for a new link.',
        });
        controller.settleHarnessLogin('succeeded');
        expect((await state(client)).status).toBe('working');
        expect(() => {
            controller.settleHarnessLogin('succeeded');
        }).toThrow(/no harness sign-in/);
    });

    it('goes back to the tools with the reason when none passes its check', async () => {
        const { client, controller, advance } = setup();
        controller.failHarnessCheck('codex', 'Codex could not reach OpenAI from this engine.');
        await toSignIn(client, advance, 'codex');
        advance(DEVICE_LOGIN_MS + CHECK_MS);
        const harnesses = await state(client);
        expect(harnesses.prompt?.kind).toBe('choice');
        expect(errorOf(harnesses)).toMatch(/None of the chosen/);
        expect(harnesses.activity.at(-1)).toMatchObject({
            status: 'failed',
            detail: 'Codex could not reach OpenAI from this engine.',
        });
        expect((await answer(client, { kind: 'choice', choiceIds: ['claude'] })).activity).toEqual([
            expect.objectContaining({ id: 'install-claude', status: 'skipped' }),
        ]);
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
        const wrongKinds: OnboardingAnswer[] = [
            { kind: 'confirm', confirmed: true },
            { kind: 'upload', fileIds: [] },
            { kind: 'secret', value: API_KEY },
        ];
        for (const wrong of wrongKinds) {
            const response = await client.onboarding.answer(
                { promptId: current.prompt?.id ?? '', action: 'answer', answer: wrong },
                signal(),
            );
            expect(code(response)).toBe('validation-failed');
        }
        expect(await state(client)).toEqual(current);
    });

    it('asks again for files it does not have, for one of the tools offered, and for a name', async () => {
        const { client, advance } = setup();
        const missing = await answer(client, { kind: 'text', text: 'x', fileIds: [FileId.parse('file-nope')] });
        expect(missing.prompt?.kind).toBe('text');
        expect(errorOf(missing)).toMatch(/files you uploaded/);
        await answer(client, { kind: 'text', text: '', fileIds: [] });
        for (const choiceIds of [[], ['codex', 'cursor']]) {
            const refused = await answer(client, { kind: 'choice', choiceIds });
            expect(refused.prompt?.kind).toBe('choice');
            expect(errorOf(refused)).toMatch(/at least one/);
        }
        await answer(client, { kind: 'choice', choiceIds: ['claude'] });
        await answer(client, { kind: 'harness-login', returnCode: 'a1B2c3D4e5' });
        advance(CHECK_MS);
        expect((await state(client)).prompt).toMatchObject({ initial: 'My project' });
        const blank = await answer(client, { kind: 'text', text: '  ', fileIds: [] });
        expect(blank.prompt).toMatchObject({ title: 'Project name', error: 'Enter a project name.' });
        const folder = await answer(client, { kind: 'text', text: '★★★', fileIds: [] });
        expect(folder.prompt).toMatchObject({ initial: 'my-project' });
        await answer(client, { kind: 'text', text: 'my-project', fileIds: [] });
        const declined = await answer(client, { kind: 'confirm', confirmed: false });
        expect(declined.prompt).toMatchObject({ title: 'Project folder' });
        await answer(client, { kind: 'text', text: 'my-project', fileIds: [] });
        const review = (await state(client)).prompt;
        expect(review?.kind === 'confirm' && review.details.map(({ label }) => label)).toEqual([
            'Project',
            'Folder',
            'AI tools',
            'Brief',
        ]);
    });

    it('stays pending and reachable when skipped for now on an engine that has a project', async () => {
        const { client } = setup();
        expect((await state(client)).canDefer).toBe(true);
        const deferred = ok(await client.onboarding.defer(signal()));
        expect(deferred).toMatchObject({ status: 'pending', deferred: true });
        expect((await answer(client, { kind: 'text', text: 'x', fileIds: [] })).deferred).toBe(true);
    });

    it('offers no attachments without files@1, and none of its routes without onboarding@1', async () => {
        const { client } = setup({ capabilities: [KNOWN_CAPABILITIES.onboarding] });
        expect((await state(client)).prompt).toMatchObject({ kind: 'text', attachments: false });
        const bare = setup({ capabilities: [KNOWN_CAPABILITIES.files] }).client;
        expect(code(await bare.onboarding.get(signal()))).toBe('capability-not-supported');
        expect(code(await bare.onboarding.defer(signal()))).toBe('capability-not-supported');
    });

    it('is completed by default, and needs settings.manage', async () => {
        const done = createInMemoryEngine().client;
        expect(await state(done)).toMatchObject({ status: 'completed', canDefer: true, prompt: null });
        const member = setup({ member: { id: 'member-ada', role: 'member', permissions: ['agents.read'] } }).client;
        expect(code(await member.onboarding.get(signal()))).toBe('forbidden');
    });

    it('accepts only an answer with action answer, no answer with back, and an alternative by ID', () => {
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
        expect(AnswerOnboardingBody.safeParse({ promptId: 'p', action: 'alternative' }).success).toBe(false);
        expect(
            AnswerOnboardingBody.safeParse({ promptId: 'p', action: 'answer', answer: { kind: 'secret', value: '' } })
                .success,
        ).toBe(false);
    });
});

describe('OnboardingStateReader', () => {
    const prompt = {
        id: 'prompt-1',
        title: 'Your project',
        question: 'What are you working on?',
        hint: null,
        error: null,
        canGoBack: false,
    };
    const stateWith = (value: unknown) => ({
        status: 'pending',
        deferred: false,
        canDefer: false,
        progress: null,
        activity: [],
        prompt: value,
    });

    it('preserves optional choice visibility and accepts older engines that omit it', () => {
        const choice = { id: 'one', label: 'One', description: null, disabled: false };
        const choices = [choice, { ...choice, id: 'two', featured: false }, { ...choice, id: 'three', featured: true }];
        const state = stateWith({ ...prompt, kind: 'choice', multiple: true, initial: ['one'], choices });
        expect(OnboardingState.parse(state).prompt).toMatchObject({ choices });
        expect(OnboardingStateReader.parse(state).prompt).toMatchObject({ choices });
    });

    it('reads a prompt of a kind it does not know as unsupported, keeping its heading and question', () => {
        const read = OnboardingStateReader.parse(
            stateWith({ ...prompt, kind: 'terminal', rows: 24, details: 'whatever a newer engine sends' }),
        );
        expect(read.prompt).toEqual({
            kind: 'unsupported',
            engineKind: 'terminal',
            id: 'prompt-1',
            title: 'Your project',
            question: 'What are you working on?',
        });
    });

    it('still refuses a known kind with a bad field, and an unknown kind without its question', () => {
        const text = { ...prompt, kind: 'text', placeholder: null, initial: '', attachments: false, required: true };
        expect(OnboardingStateReader.safeParse(stateWith({ ...text, multiline: 'yes' })).success).toBe(false);
        const blank = stateWith({ ...prompt, kind: 'terminal', question: '' });
        expect(OnboardingStateReader.safeParse(blank).success).toBe(false);
    });

    it('reads an engine from before the input kinds with their defaults, and drops fields it does not know', () => {
        const read = OnboardingStateReader.parse({
            status: 'pending',
            deferred: false,
            progress: { step: 1, of: 3 },
            prompt: { ...prompt, kind: 'confirm', confirmLabel: 'Yes', declineLabel: 'No', mood: 'cheerful' },
            future: true,
        });
        expect(read).toMatchObject({ canDefer: true, activity: [] });
        expect(read.prompt).toEqual({
            ...prompt,
            kind: 'confirm',
            confirmLabel: 'Yes',
            declineLabel: 'No',
            details: [],
            alternatives: [],
        });
    });

    it('refuses an alternative that leaves the engine origin', () => {
        for (const href of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)']) {
            const confirm = {
                ...prompt,
                kind: 'confirm',
                confirmLabel: 'Check sign-in',
                declineLabel: 'Later',
                alternatives: [{ id: 'terminal', label: 'Terminal', description: null, href }],
            };
            expect(OnboardingStateReader.safeParse(stateWith(confirm)).success).toBe(false);
        }
    });
});
