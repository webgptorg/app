import { ChatId, KNOWN_CAPABILITIES, MAX_SPEECH_TEXT_LENGTH, MessageId } from '@ptbk/engine-api';
import type { CapabilityRef, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine, DEFAULT_CAPABILITIES, FAKE_TRANSCRIPTS } from '@ptbk/engine-api/in-memory';
import { UiProvider } from '@ptbk/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense } from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BrowserProvider } from '../../app/browser-context';
import { EngineApiProvider } from '../../app/engine-api-context';
import { TickerProvider } from '../../app/ticker';
import { createUiMessages } from '../../app/ui-messages';
import { OWNER_ID } from '../../testing/agents-engine';
import { expectNoAxeViolations } from '../../testing/axe';
import { CHAT_AGENT_ID, seededConversation } from '../../testing/chat-engine';
import { createFakeLocation } from '../../testing/fake-location';
import { createFakeMatchMedia } from '../../testing/fake-match-media';
import { createFakeVoiceMedia } from '../../testing/fake-voice-media';
import type { FakeVoiceMedia, FakeVoiceMediaOptions } from '../../testing/fake-voice-media';
import { createManualTicker } from '../../testing/manual-ticker';
import { createMemoryStorage } from '../../testing/memory-storage';
import { renderUi } from '../../testing/render-ui';
import { TEST_NOW } from '../../testing/test-engine-api';
import { ComposerVoiceInput } from './composer-voice-input';
import { MessageReadAloud } from './message-read-aloud';
import { PushToTalkButton } from './push-to-talk-button';
import type { PushToTalkState } from './push-to-talk';
import { ReadAloudButton } from './read-aloud-button';

const CHAT = ChatId.parse('chat-voice');
const MESSAGE = MessageId.parse('chat-voice#1');
const VOICE = [KNOWN_CAPABILITIES.voiceInput, KNOWN_CAPABILITIES.voiceOutput];
const WEBM_SECOND = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array(3_996)]);
const noop = () => undefined;

interface Setup {
    readonly capabilities?: readonly CapabilityRef[];
    readonly permissions?: readonly Permission[];
    readonly browser?: FakeVoiceMediaOptions;
}

function setup({ capabilities = VOICE, permissions, browser }: Setup = {}) {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        capabilities: [...DEFAULT_CAPABILITIES, ...capabilities],
        seed: {
            agents: [{ id: CHAT_AGENT_ID, source: 'Ada\nPERSONA Research' }],
            chats: [seededConversation(CHAT, 2, OWNER_ID)],
        },
        ...(permissions === undefined ? {} : { member: { id: OWNER_ID, permissions, role: 'member' } }),
    });
    const media = createFakeVoiceMedia(browser);
    const ticker = createManualTicker(0);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
        <UiProvider messages={createUiMessages()} locale="en">
            <BrowserProvider
                browser={{
                    storage: createMemoryStorage(),
                    matchMedia: createFakeMatchMedia().matchMedia,
                    location: createFakeLocation('/'),
                    fetch: vi.fn<typeof fetch>(),
                    timeZone: 'UTC',
                    voiceMedia: media,
                }}
            >
                <EngineApiProvider client={engine.client}>
                    <QueryClientProvider client={queryClient}>
                        <TickerProvider ticker={ticker}>
                            <Suspense fallback={<p>loading</p>}>
                                <div data-testid="slot">{children}</div>
                            </Suspense>
                        </TickerProvider>
                    </QueryClientProvider>
                </EngineApiProvider>
            </BrowserProvider>
        </UiProvider>
    );
    return { engine, media, ticker, wrapper, user: userEvent.setup() };
}

async function settled() {
    await waitFor(() => {
        expect(screen.queryByText('loading')).toBeNull();
    });
}

function liveRecorder(media: FakeVoiceMedia) {
    const recorder = media.recorders.at(-1);
    if (recorder === undefined) throw new Error('not recording');
    return recorder;
}

describe('PushToTalkButton', () => {
    const states: readonly [string, PushToTalkState, number][] = [
        ['idle', { kind: 'idle' }, 0],
        ['starting', { kind: 'starting' }, 0],
        ['recording', { kind: 'recording', startedAt: 0 }, 12_000],
        ['transcribing', { kind: 'transcribing' }, 0],
        ['failed', { kind: 'failed', problem: 'microphone-denied' }, 0],
    ];

    it.each(states)('is accessible while %s', async (_, state, elapsedMs) => {
        const { container } = renderUi(
            <PushToTalkButton state={state} elapsedMs={elapsedMs} onStart={noop} onStop={noop} onCancel={noop} />,
        );
        await expectNoAxeViolations(container);
    });

    it('starts, and is off while the composer cannot take text', async () => {
        const onStart = vi.fn();
        const { rerender } = renderUi(
            <PushToTalkButton state={{ kind: 'idle' }} elapsedMs={0} onStart={onStart} onStop={noop} onCancel={noop} />,
        );
        await userEvent.click(screen.getByRole('button', { name: 'Dictate a message' }));
        expect(onStart).toHaveBeenCalledOnce();
        rerender(
            <PushToTalkButton
                state={{ kind: 'idle' }}
                elapsedMs={0}
                onStart={onStart}
                onStop={noop}
                onCancel={noop}
                disabled
            />,
        );
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Dictate a message' }).disabled).toBe(true);
    });

    it('shows the time while recording, the limit near the end, and stops or discards', async () => {
        const onStop = vi.fn();
        const onCancel = vi.fn();
        const recording = (elapsedMs: number) => (
            <PushToTalkButton
                state={{ kind: 'recording', startedAt: 0 }}
                elapsedMs={elapsedMs}
                onStart={noop}
                onStop={onStop}
                onCancel={onCancel}
            />
        );
        const { rerender } = renderUi(recording(12_400));
        screen.getByText('0:12');
        expect(screen.getByRole('status').textContent).toContain('Recording');
        rerender(recording(52_000));
        screen.getByText('0:52 of 1:00');
        rerender(recording(75_000));
        screen.getByText('1:00 of 1:00');
        await userEvent.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
        await userEvent.click(screen.getByRole('button', { name: 'Discard recording' }));
        expect(onStop).toHaveBeenCalledOnce();
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('is busy while transcribing and says what went wrong after a failure', () => {
        const { rerender } = renderUi(
            <PushToTalkButton
                state={{ kind: 'transcribing' }}
                elapsedMs={0}
                onStart={noop}
                onStop={noop}
                onCancel={noop}
            />,
        );
        expect(screen.getByRole('button', { name: 'Transcribing…' }).getAttribute('aria-busy')).toBe('true');
        expect(screen.getByRole('status').textContent).toContain('Transcribing…');
        rerender(
            <PushToTalkButton
                state={{ kind: 'failed', problem: 'microphone-denied' }}
                elapsedMs={0}
                onStart={noop}
                onStop={noop}
                onCancel={noop}
            />,
        );
        expect(screen.getByRole('alert').textContent).toContain('Microphone access is blocked.');
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Dictate a message' }).disabled).toBe(false);
    });
});

describe('ReadAloudButton', () => {
    it('reads, loads, stops and fails in words', async () => {
        const onToggle = vi.fn();
        const { rerender, container } = renderUi(<ReadAloudButton state={{ kind: 'idle' }} onToggle={onToggle} />);
        await userEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
        expect(onToggle).toHaveBeenCalledOnce();
        rerender(<ReadAloudButton state={{ kind: 'loading' }} onToggle={onToggle} />);
        expect(screen.getByRole('button', { name: 'Preparing audio…' }).getAttribute('aria-busy')).toBe('true');
        rerender(<ReadAloudButton state={{ kind: 'playing' }} onToggle={onToggle} />);
        await userEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
        expect(onToggle).toHaveBeenCalledTimes(2);
        rerender(<ReadAloudButton state={{ kind: 'failed', problem: 'speech-failed' }} onToggle={onToggle} />);
        expect(screen.getByRole('alert').textContent).toContain("The message couldn't be read aloud.");
        await expectNoAxeViolations(container);
    });

    it('stays focusable and says why when the message cannot be read', async () => {
        const onToggle = vi.fn();
        renderUi(<ReadAloudButton state={{ kind: 'idle' }} onToggle={onToggle} disabledReason="Too long." />);
        const button = screen.getByRole('button', { name: 'Read aloud' });
        expect(button.getAttribute('aria-disabled')).toBe('true');
        await userEvent.click(button);
        expect(onToggle).not.toHaveBeenCalled();
    });
});

describe('ComposerVoiceInput', () => {
    it.each([
        ['the engine does not advertise voice-input@1', { capabilities: [KNOWN_CAPABILITIES.voiceOutput] }],
        ['the member may not write in chats', { permissions: ['chats.read'] as const }],
        ['the browser cannot record', { browser: { microphone: false } }],
        ['the browser records no format the contract takes', { browser: { recordable: ['audio/mp4'] } }],
    ] satisfies readonly [string, Setup][])('renders nothing when %s', async (_, options) => {
        const { wrapper } = setup(options);
        render(<ComposerVoiceInput chatId={CHAT} onDraft={noop} />, { wrapper });
        await settled();
        expect(screen.getByTestId('slot').childElementCount).toBe(0);
    });

    it('records, ticks, transcribes on the engine and hands the draft on, releasing the microphone', async () => {
        const { wrapper, media, ticker, user } = setup();
        const onDraft = vi.fn<(text: string) => void>();
        render(<ComposerVoiceInput chatId={CHAT} onDraft={onDraft} />, { wrapper });
        await user.click(await screen.findByRole('button', { name: 'Dictate a message' }));
        await screen.findByRole('button', { name: 'Stop and transcribe' });
        expect(liveRecorder(media).mediaType).toBe('audio/webm;codecs=opus');
        expect(media.liveTracks()).toBe(1);
        act(() => {
            ticker.advance(12_000);
        });
        screen.getByText('0:12');

        liveRecorder(media).emit(WEBM_SECOND);
        await user.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
        expect(media.liveTracks()).toBe(0);
        await waitFor(() => {
            expect(onDraft).toHaveBeenCalledOnce();
        });
        expect(FAKE_TRANSCRIPTS).toContain(onDraft.mock.calls[0]?.[0]);
        screen.getByRole('button', { name: 'Dictate a message' });
    });

    it('says when the engine cannot transcribe right now', async () => {
        const { wrapper, media, user, engine } = setup();
        engine.controller.failVoice('voice-unavailable');
        render(<ComposerVoiceInput chatId={CHAT} onDraft={noop} />, { wrapper });
        await user.click(await screen.findByRole('button', { name: 'Dictate a message' }));
        await screen.findByRole('button', { name: 'Stop and transcribe' });
        liveRecorder(media).emit(WEBM_SECOND);
        await user.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
        expect((await screen.findByRole('alert')).textContent).toContain(
            "Voice isn't available in this project right now.",
        );
    });

    it('releases the microphone when unmounted mid-recording', async () => {
        const { wrapper, media, user } = setup();
        const { unmount } = render(<ComposerVoiceInput chatId={CHAT} onDraft={noop} />, { wrapper });
        await user.click(await screen.findByRole('button', { name: 'Dictate a message' }));
        await screen.findByRole('button', { name: 'Stop and transcribe' });
        expect(media.liveTracks()).toBe(1);
        unmount();
        expect(media.liveTracks()).toBe(0);
        expect(liveRecorder(media).state).toBe('inactive');
    });
});

describe('MessageReadAloud', () => {
    const props = { chatId: CHAT, messageId: MESSAGE, content: 'Answer 2', completed: true };

    it.each([
        ['the engine does not advertise voice-output@1', { capabilities: [KNOWN_CAPABILITIES.voiceInput] }, props],
        ['the member may not read chats', { permissions: ['chats.write'] as const }, props],
        ['the browser has no audio output', { browser: { speaker: false } }, props],
        ['the browser plays no offered format', { browser: { playable: ['audio/flac'] } }, props],
        ['the message is still streaming', {}, { ...props, completed: false }],
        ['the message has no text', {}, { ...props, content: '  ' }],
    ] satisfies readonly [string, Setup, typeof props][])('renders nothing when %s', async (_, options, message) => {
        const { wrapper } = setup(options);
        render(<MessageReadAloud {...message} />, { wrapper });
        await settled();
        expect(screen.getByTestId('slot').childElementCount).toBe(0);
    });

    it('says a message is too long before asking the engine', async () => {
        const { wrapper } = setup();
        render(<MessageReadAloud {...props} content={'a'.repeat(MAX_SPEECH_TEXT_LENGTH + 1)} />, { wrapper });
        expect((await screen.findByRole('button', { name: 'Read aloud' })).getAttribute('aria-disabled')).toBe('true');
    });

    it('plays the engine audio, and stops and frees the output when unmounted', async () => {
        const { wrapper, media, user } = setup();
        const { unmount } = render(<MessageReadAloud {...props} />, { wrapper });
        await user.click(await screen.findByRole('button', { name: 'Read aloud' }));
        await screen.findByRole('button', { name: 'Stop reading' });
        expect(media.outputs[0]?.played).toHaveLength(1);
        unmount();
        expect(media.outputs[0]?.closed).toBe(true);
    });

    it('stops on a second click and reads again on a third', async () => {
        const { wrapper, media, user } = setup();
        render(<MessageReadAloud {...props} />, { wrapper });
        await user.click(await screen.findByRole('button', { name: 'Read aloud' }));
        await user.click(await screen.findByRole('button', { name: 'Stop reading' }));
        expect(media.outputs[0]?.closed).toBe(true);
        await user.click(screen.getByRole('button', { name: 'Read aloud' }));
        await screen.findByRole('button', { name: 'Stop reading' });
        expect(media.outputs).toHaveLength(2);
    });
});
