import { AgentId, createProblem, MAX_BOOK_SOURCE_LENGTH } from '@ptbk/engine-api';
import type { EngineApiClient, Permission, TestChatEvent } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../../testing/axe';
import { bookText, installEditorDomGaps, replaceBook } from '../../../testing/book-editor';
import { createControlledStream } from '../../../testing/chat-engine';
import type { ControlledStream } from '../../../testing/chat-engine';
import { renderWithProviders } from '../../../testing/render-with-providers';
import { TEST_NOW } from '../../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const WAIT = { timeout: 5_000 };

installEditorDomGaps();

const AGENT = AgentId.parse('agent-ada');
const SOURCE = 'Ada\nPERSONA Research';
const WITHOUT_WRITE: readonly Permission[] = ['agents.read', 'members.read'];

type TestChat = EngineApiClient['testChat'];

interface Setup {
    readonly permissions?: readonly Permission[];
    readonly noCapability?: true;
    readonly testChat?: TestChat;
}

function setup({ permissions, noCapability, testChat }: Setup = {}) {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            agents: [{ id: AGENT, source: SOURCE }],
        },
        ...(noCapability ? { capabilities: [] } : {}),
        ...(permissions === undefined ? {} : { member: { id: 'member-owner', permissions, role: 'member' } }),
    });
    const client: EngineApiClient = { ...engine.client, testChat: testChat ?? engine.client.testChat };
    const spies = {
        stream: vi.spyOn(client.testChat, 'stream'),
        updateSource: vi.spyOn(client.agents, 'updateSource'),
    };
    const app = renderWithProviders({ path: `/agents/${AGENT}/book`, engineApi: client });
    return { ...app, engine, spies };
}

async function open(options: Setup = {}) {
    const app = setup(options);
    await screen.findByTestId('book-editor', {}, WAIT);
    await waitFor(() => {
        expect(bookText()).toBe(SOURCE);
    });
    return app;
}

const panel = () => screen.getByTestId('book-test-chat');
const composer = () => within(panel()).getByRole('textbox', { name: 'Message' });

async function send(app: Awaited<ReturnType<typeof open>>, text: string) {
    await app.user.click(composer());
    await app.user.keyboard(text);
    await app.user.keyboard('{Enter}');
}

/** Hands every test request a stream the test drives, and records the bodies sent. */
function controlledTestChat() {
    const streams: ControlledStream<TestChatEvent>[] = [];
    const testChat: TestChat = {
        stream: (_agentId, _body, signal) => {
            const stream = createControlledStream<TestChatEvent>(signal);
            streams.push(stream);
            return Promise.resolve({ kind: 'ok', data: stream.iterable });
        },
    };
    const latest = () => {
        const stream = streams.at(-1);
        if (stream === undefined) throw new Error('no test request yet');
        return stream;
    };
    return { testChat, streams, latest };
}

describe('the book editor test chat', { timeout: TIMEOUT_MS }, () => {
    it('labels the panel a test that is not saved, and has no accessibility violations', async () => {
        const { container } = await open();
        expect(within(panel()).getByRole('heading', { name: 'Test chat' })).toBeDefined();
        expect(within(panel()).getByText('Test · not saved')).toBeDefined();
        expect(within(panel()).getByText(/These messages are not kept/)).toBeDefined();
        expect(screen.getByRole('group', { name: 'Show' })).toBeDefined();
        await expectNoAxeViolations(container);
    });

    it('is not there without agents.write', async () => {
        setup({ permissions: WITHOUT_WRITE });
        await screen.findByTestId('book-editor', {}, WAIT);
        expect(screen.queryByTestId('book-test-chat')).toBeNull();
        expect(screen.queryByRole('group', { name: 'Show' })).toBeNull();
    });

    it('is not there when the engine does not advertise test-chat@1', async () => {
        await open({ noCapability: true });
        expect(screen.queryByTestId('book-test-chat')).toBeNull();
    });

    it('answers from the unsaved draft and saves nothing', async () => {
        const app = await open();
        replaceBook('Draft Ada\nPERSONA Tries things');
        await send(app, 'hello');
        expect(await within(panel()).findByText('Draft Ada received: hello', {}, WAIT)).toBeDefined();
        expect(app.spies.stream).toHaveBeenCalledWith(
            AGENT,
            { book: 'Draft Ada\nPERSONA Tries things', messages: [{ role: 'user', content: 'hello' }] },
            expect.any(AbortSignal),
        );
        await send(app, 'again');
        await within(panel()).findByText('Draft Ada received: again', {}, WAIT);
        expect(app.spies.stream.mock.calls[1]?.[1].messages).toEqual([
            { role: 'user', content: 'hello' },
            { role: 'agent', content: 'Draft Ada received: hello' },
            { role: 'user', content: 'again' },
        ]);
        expect(app.spies.updateSource).not.toHaveBeenCalled();
        const saved = await app.engine.client.agents.getSource(AGENT, AbortSignal.timeout(1_000));
        expect(saved.kind === 'ok' && saved.data.source).toBe(SOURCE);
        expect(screen.getByText('Unsaved changes')).toBeDefined();
    });

    it('stops a reply, keeps what streamed and leaves an empty stopped reply out of the next request', async () => {
        const control = controlledTestChat();
        const app = await open({ testChat: control.testChat });
        await send(app, 'one');
        control.latest().push({ type: 'delta', seq: 1, text: 'Partial' });
        await within(panel()).findByText('Partial', {}, WAIT);
        await app.user.click(within(panel()).getByRole('button', { name: 'Stop' }));
        expect(control.latest().aborted()).toBe(true);
        expect(within(panel()).getByText('Stopped')).toBeDefined();
        await send(app, 'two');
        await app.user.keyboard('{Escape}');
        expect(control.latest().aborted()).toBe(true);
        await send(app, 'three');
        expect(app.spies.stream.mock.calls[2]?.[1].messages).toEqual([
            { role: 'user', content: 'one' },
            { role: 'agent', content: 'Partial' },
            { role: 'user', content: 'two' },
            { role: 'user', content: 'three' },
        ]);
    });

    it('resets the conversation and stops a reply in progress', async () => {
        const control = controlledTestChat();
        const app = await open({ testChat: control.testChat });
        await send(app, 'one');
        control.latest().push({ type: 'delta', seq: 1, text: 'Going' });
        await within(panel()).findByText('Going', {}, WAIT);
        expect(within(panel()).queryByText(/These messages are not kept/)).toBeNull();
        await app.user.click(within(panel()).getByRole('button', { name: 'Reset' }));
        expect(control.latest().aborted()).toBe(true);
        expect(within(panel()).getByText(/These messages are not kept/)).toBeDefined();
        expect(within(panel()).queryByText('one')).toBeNull();
    });

    it('offers a retry after a failed or dropped reply, replacing the partial text', async () => {
        const control = controlledTestChat();
        const app = await open({ testChat: control.testChat });
        await send(app, 'one');
        control.latest().push({ type: 'delta', seq: 1, text: 'Half' });
        control.latest().push({ type: 'failed', problem: createProblem('reply-failed') });
        expect(await within(panel()).findByText('The test reply failed.', {}, WAIT)).toBeDefined();
        await app.user.click(within(panel()).getByRole('button', { name: 'Try again' }));
        expect(app.spies.stream.mock.calls[1]?.[1].messages).toEqual([{ role: 'user', content: 'one' }]);
        control.latest().end();
        expect(
            await within(panel()).findByText('The connection was lost before the reply finished.', {}, WAIT),
        ).toBeDefined();
        await app.user.click(within(panel()).getByRole('button', { name: 'Try again' }));
        control.latest().push({ type: 'delta', seq: 1, text: 'Whole' });
        control.latest().push({ type: 'completed', content: 'Whole reply' });
        expect(await within(panel()).findByText('Whole reply', {}, WAIT)).toBeDefined();
        expect(within(panel()).queryByText('The connection was lost before the reply finished.')).toBeNull();
    });

    it('says when the engine refuses the member with 403', async () => {
        const app = await open({
            testChat: {
                stream: () =>
                    Promise.resolve({
                        kind: 'problem',
                        problem: createProblem('forbidden', { requiredPermission: 'agents.write' }),
                    }),
            },
        });
        await send(app, 'hi');
        expect(await within(panel()).findByText("You may not test this agent's book.", {}, WAIT)).toBeDefined();
        expect(within(panel()).queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    it('reads a network failure as a lost connection', async () => {
        const app = await open({ testChat: { stream: () => Promise.reject(new TypeError('Failed to fetch')) } });
        await send(app, 'hi');
        expect(
            await within(panel()).findByText('The connection was lost before the reply finished.', {}, WAIT),
        ).toBeDefined();
        expect(within(panel()).getByRole('button', { name: 'Try again' })).toBeDefined();
    });

    it('refuses an oversized draft without sending it', async () => {
        const app = await open();
        replaceBook(`Ada\n${'a'.repeat(MAX_BOOK_SOURCE_LENGTH)}`);
        await send(app, 'hi');
        expect(await within(panel()).findByText('The book is too large to test.', {}, WAIT)).toBeDefined();
        expect(app.spies.stream).not.toHaveBeenCalled();
        expect(composer()).toHaveProperty('value', 'hi');
    });

    it('shows an invalid book as problems in the editor and retries once fixed', async () => {
        const app = await open();
        replaceBook('Ada\nMETA COLOR red');
        await send(app, 'hi');
        expect(
            await within(panel()).findByText(
                'The book has errors, so it cannot be tested. Fix them and try again.',
                {},
                WAIT,
            ),
        ).toBeDefined();
        expect(await screen.findByRole('button', { name: /META COLOR needs a #rrggbb colour/ }, WAIT)).toBeDefined();
        await app.user.click(within(panel()).getByRole('button', { name: 'Show problems' }));
        expect(screen.getByRole('button', { name: 'Book', pressed: true })).toBeDefined();
        replaceBook('Ada\nMETA COLOR #3366ff');
        await app.user.click(within(panel()).getByRole('button', { name: 'Try again' }));
        expect(await within(panel()).findByText('Ada received: hi', {}, WAIT)).toBeDefined();
    });

    it('switches between the book and the test chat on narrow screens without losing either', async () => {
        const app = await open();
        replaceBook('Draft\nPERSONA x');
        await app.user.click(screen.getByRole('button', { name: 'Test', pressed: false }));
        expect(panel().className).not.toContain('max-xl:hidden');
        // Sized while hidden, the composer must not have collapsed to nothing.
        expect(composer().style.height).not.toBe('0px');
        expect(screen.getByTestId('book-editor').closest('.max-xl\\:hidden')).not.toBeNull();
        await send(app, 'hi');
        await within(panel()).findByText('Draft received: hi', {}, WAIT);
        await app.user.click(screen.getByRole('button', { name: 'Book', pressed: false }));
        expect(panel().className).toContain('max-xl:hidden');
        expect(bookText()).toBe('Draft\nPERSONA x');
        expect(within(panel()).getByText('Draft received: hi')).toBeDefined();
    });
});
