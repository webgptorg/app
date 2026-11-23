import { ChatId, KNOWN_CAPABILITIES, MessageId, PROBLEM_STATUS } from '@ptbk/engine-api';
import type { EngineApiClient, ProblemCode } from '@ptbk/engine-api';
import { createInMemoryEngine, DEFAULT_CAPABILITIES } from '@ptbk/engine-api/in-memory';
import { describe, expect, it, vi } from 'vitest';

import { OWNER_ID } from '../../testing/agents-engine';
import { CHAT_AGENT_ID, seededConversation } from '../../testing/chat-engine';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';
import { speakMessage, transcribeClip } from './voice-api';
import { microphoneProblem, voiceProblemFromFailure, voiceProblemMessage } from './voice-problems';
import type { VoiceProblem } from './voice-problems';

const CHAT = ChatId.parse('chat-voice');
const MESSAGE = MessageId.parse('chat-voice#1');
const signal = () => new AbortController().signal;
/** One second of Opus in WebM as the in-memory transcriber estimates it: the magic, then 32 kbit. */
const WEBM = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array(3_996)], {
    type: 'audio/webm;codecs=opus',
});

function engine() {
    return createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        capabilities: [...DEFAULT_CAPABILITIES, KNOWN_CAPABILITIES.voiceInput, KNOWN_CAPABILITIES.voiceOutput],
        seed: {
            agents: [{ id: CHAT_AGENT_ID, source: 'Ada\nPERSONA Research' }],
            chats: [seededConversation(CHAT, 2, OWNER_ID)],
        },
    });
}

describe('voice calls', () => {
    it('transcribe a clip into a draft and add nothing to the chat', async () => {
        const { client } = engine();
        const before = await client.chats.get(CHAT, signal());
        const result = await transcribeClip(client, { chatId: CHAT, clip: WEBM, language: 'cs' }, signal());
        expect(result).toMatchObject({ kind: 'ok', value: { language: 'cs', durationMs: 1_000 } });
        expect(await client.chats.get(CHAT, signal())).toEqual(before);
    });

    it('read a message aloud in the first offered format the engine makes', async () => {
        const { client } = engine();
        const result = await speakMessage(
            client,
            { chatId: CHAT, messageId: MESSAGE, formats: ['audio/mpeg', 'audio/wav'] },
            signal(),
        );
        expect(result.kind === 'ok' && result.value.type).toBe('audio/wav');
    });

    it.each([
        ['transcription-failed', 'transcription-failed'],
        ['voice-unavailable', 'voice-unavailable'],
    ] as const)('pass on the provider failing with %s', async (fault, problem) => {
        const { client, controller } = engine();
        controller.failVoice(fault);
        expect(await transcribeClip(client, { chatId: CHAT, clip: WEBM }, signal())).toEqual({
            kind: 'failed',
            problem,
        });
    });

    it('name the speech formats refused when the engine makes none of them', async () => {
        const { client } = engine();
        const result = await speakMessage(
            client,
            { chatId: CHAT, messageId: MESSAGE, formats: ['audio/mpeg'] },
            signal(),
        );
        expect(result).toEqual({ kind: 'failed', problem: 'speech-format-refused' });
    });

    it('report a lost connection, and nothing at all when the caller aborted', async () => {
        const { client } = engine();
        const offline: EngineApiClient = {
            ...client,
            voice: { ...client.voice, transcribe: () => Promise.reject(new TypeError('Failed to fetch')) },
        };
        expect(await transcribeClip(offline, { chatId: CHAT, clip: WEBM }, signal())).toEqual({
            kind: 'failed',
            problem: 'connection',
        });

        const controller = new AbortController();
        const hanging: EngineApiClient = {
            ...client,
            voice: {
                ...client.voice,
                speak: (_chat, _message, _body, inner) =>
                    new Promise((_, reject) => {
                        inner.addEventListener('abort', () => {
                            reject(new DOMException('aborted', 'AbortError'));
                        });
                    }),
            },
        };
        const pending = speakMessage(
            hanging,
            { chatId: CHAT, messageId: MESSAGE, formats: ['audio/wav'] },
            controller.signal,
        );
        controller.abort();
        expect(await pending).toEqual({ kind: 'aborted' });
    });

    it('send the language only when one is given', async () => {
        const { client } = engine();
        const transcribe = vi.fn(() => problemResponse('voice-unavailable'));
        const spied: EngineApiClient = { ...client, voice: { ...client.voice, transcribe } };
        await transcribeClip(spied, { chatId: CHAT, clip: WEBM }, signal());
        expect(transcribe).toHaveBeenCalledWith(CHAT, WEBM, {}, expect.any(AbortSignal));
    });
});

describe('voice problems', () => {
    const problem = (code: ProblemCode) =>
        ({
            kind: 'problem',
            problem: { type: 'about:blank', title: code, status: PROBLEM_STATUS[code], code },
        }) as const;

    it.each([
        ['payload-too-large', 'transcribe', 'clip-too-large'],
        ['voice-clip-too-long', 'transcribe', 'clip-too-long'],
        ['unsupported-media-type', 'transcribe', 'clip-format-refused'],
        ['transcription-failed', 'transcribe', 'transcription-failed'],
        ['unsupported-media-type', 'speak', 'speech-format-refused'],
        ['speech-too-long', 'speak', 'speech-too-long'],
        ['message-not-speakable', 'speak', 'message-not-speakable'],
        ['speech-failed', 'speak', 'speech-failed'],
        ['voice-unavailable', 'speak', 'voice-unavailable'],
        ['rate-limited', 'speak', 'rate-limited'],
        ['forbidden', 'transcribe', 'voice-not-allowed'],
        ['not-found', 'speak', 'voice-not-allowed'],
        ['capability-not-supported', 'transcribe', 'voice-not-allowed'],
        ['internal-error', 'transcribe', 'unexpected'],
    ] as const)('map %s on %s to %s', (code, action, expected) => {
        expect(voiceProblemFromFailure(problem(code), action)).toBe(expected);
    });

    it('map failures without an answer', () => {
        expect(voiceProblemFromFailure({ kind: 'network' }, 'speak')).toBe('connection');
        expect(voiceProblemFromFailure({ kind: 'timeout' }, 'speak')).toBe('connection');
        expect(voiceProblemFromFailure({ kind: 'contract' }, 'speak')).toBe('unexpected');
        expect(voiceProblemFromFailure({ kind: 'unexpected' }, 'speak')).toBe('unexpected');
        expect(microphoneProblem('not an error')).toBe('recording-failed');
    });

    it('give every problem its own plain sentence, never the engine detail', () => {
        const problems: readonly VoiceProblem[] = [
            'microphone-denied',
            'microphone-missing',
            'microphone-busy',
            'recording-failed',
            'clip-too-large',
            'clip-too-long',
            'clip-format-refused',
            'nothing-heard',
            'transcription-failed',
            'speech-too-long',
            'message-not-speakable',
            'speech-format-refused',
            'speech-failed',
            'playback-failed',
            'voice-unavailable',
            'voice-not-allowed',
            'rate-limited',
            'connection',
            'unexpected',
        ];
        const messages = problems.map(voiceProblemMessage);
        expect(new Set(messages).size).toBe(problems.length);
        for (const message of messages) expect(message).toMatch(/^\p{Lu}.*\.$/u);
    });
});
