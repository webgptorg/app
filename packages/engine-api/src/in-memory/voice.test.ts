import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import { MAX_SPEECH_TEXT_LENGTH, MAX_VOICE_CLIP_BYTES, MAX_VOICE_CLIP_MS } from '../capabilities/voice';
import { createEngineApiClient } from '../client';
import type { EngineApiResponse } from '../client';
import { ChatId, MessageId } from '../common';
import {
    DEFAULT_CAPABILITIES,
    actorFromOptions,
    createInMemoryEngine,
    createInMemoryEngineCore,
} from '../in-memory-client';
import { OWNER_PERMISSIONS } from '../permissions';
import type { Permission } from '../permissions';
import { withClientReading } from '../reader';
import { FAKE_TRANSCRIPTS, sha256Hex, toneWav } from './voice';

const VOICE = [KNOWN_CAPABILITIES.voiceInput, KNOWN_CAPABILITIES.voiceOutput];
const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function codeOf(response: EngineApiResponse<unknown>): string {
    if (response.kind !== 'problem') throw new Error('Expected a problem');
    return response.problem.code;
}

/** 16-bit PCM mono WAV; `value` fills every byte of the samples. */
function wav(ms: number, { sampleRate = 16_000, value = 0, format = 1 } = {}): Blob {
    const dataBytes = Math.round((sampleRate * ms) / 1000) * 2;
    const bytes = new Uint8Array(44 + dataBytes).fill(value, 44);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    view.setUint32(4, 36 + dataBytes, true);
    bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    bytes.set(new TextEncoder().encode('data'), 36);
    view.setUint32(40, dataBytes, true);
    return new Blob([bytes], { type: 'audio/wav' });
}

async function setup() {
    const core = createInMemoryEngineCore({ capabilities: [...DEFAULT_CAPABILITIES, ...VOICE] });
    const clientWithout = (missing: Permission | null) =>
        createEngineApiClient(
            withClientReading(
                core.transport(
                    actorFromOptions({ member: { permissions: OWNER_PERMISSIONS.filter((p) => p !== missing) } }),
                ),
            ),
        );
    const client = clientWithout(null);
    const agent = ok(await client.agents.create({ source: 'Ada' }, signal()));
    const chat = ok(await client.chats.create({ agentId: agent.id, title: 'Voice' }, signal()));
    const entries = async () => ok(await client.chats.listEntries(chat.id, { limit: 100 }, signal())).items;
    return { client, clientWithout, controller: core.controller, chat, entries };
}

describe('voice-input@1 in the in-memory engine', () => {
    it('hears a fixed transcript per clip and adds nothing to the chat', async () => {
        const { client, chat, entries } = await setup();
        const before = await entries();
        const clip = new Blob([toneWav(100)], { type: 'audio/wav' });
        const first = ok(await client.voice.transcribe(chat.id, clip, {}, signal()));
        expect(FAKE_TRANSCRIPTS).toContain(first.text);
        expect(first).toMatchObject({ language: 'en', confidence: 0.92, durationMs: 1000 });
        expect(ok(await client.voice.transcribe(chat.id, clip, { language: 'cs-CZ' }, signal()))).toEqual({
            ...first,
            language: 'cs-CZ',
        });
        expect(await entries()).toEqual(before);
        expect(ok(await client.chats.get(chat.id, signal())).messageCount).toBe(0);
    });

    it('hears nothing in silence, and what it is told in a given clip', async () => {
        const { client, controller, chat } = await setup();
        const silent = wav(1_500);
        expect(ok(await client.voice.transcribe(chat.id, silent, {}, signal()))).toEqual({
            text: '',
            language: 'en',
            confidence: null,
            durationMs: 1_500,
        });
        controller.setVoiceTranscript(await sha256Hex(new Uint8Array(await silent.arrayBuffer())), 'Hello, Ada.');
        expect(ok(await client.voice.transcribe(chat.id, silent, {}, signal())).text).toBe('Hello, Ada.');
        expect(() => {
            controller.setVoiceTranscript('ABC', 'x');
        }).toThrow(/SHA-256/);
    });

    it('reads Opus containers by their magic, at the UI bitrate', async () => {
        const { client, chat } = await setup();
        const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array(3_996)], {
            type: 'audio/webm;codecs=opus',
        });
        expect(ok(await client.voice.transcribe(chat.id, webm, {}, signal())).durationMs).toBe(1_000);
        const ogg = new Blob(['OggS', new Uint8Array(7_996)], { type: 'audio/ogg; codecs="opus"' });
        expect(ok(await client.voice.transcribe(chat.id, ogg, {}, signal())).durationMs).toBe(2_000);
        const fake = new Blob(['OggS', new Uint8Array(10)], { type: 'audio/webm;codecs=opus' });
        expect(codeOf(await client.voice.transcribe(chat.id, fake, {}, signal()))).toBe('transcription-failed');
    });

    it.each([
        ['no type', new Blob([toneWav(10)])],
        ['MP3', new Blob([toneWav(10)], { type: 'audio/mpeg' })],
        ['WebM without the codec', new Blob([toneWav(10)], { type: 'audio/webm' })],
        ['text', new Blob(['hello'], { type: 'text/plain' })],
        ['a malformed type', new Blob([toneWav(10)], { type: 'audio/wav;;' })],
    ])('refuses %s with 415', async (_, clip) => {
        const { client, chat } = await setup();
        expect(codeOf(await client.voice.transcribe(chat.id, clip, {}, signal()))).toBe('unsupported-media-type');
    });

    it('refuses a body that is not a Blob with 415', async () => {
        const { client, chat } = await setup();
        const notABlob = 'RIFF' as unknown as Blob;
        expect(codeOf(await client.voice.transcribe(chat.id, notABlob, {}, signal()))).toBe('unsupported-media-type');
    });

    it('refuses more than the byte cap with 413 and more than the duration cap with 422', async () => {
        const { client, chat } = await setup();
        const large = new Blob([new Uint8Array(MAX_VOICE_CLIP_BYTES + 1)], { type: 'audio/wav' });
        expect(codeOf(await client.voice.transcribe(chat.id, large, {}, signal()))).toBe('payload-too-large');
        const long = wav(MAX_VOICE_CLIP_MS + 1_000);
        expect(long.size).toBeLessThan(MAX_VOICE_CLIP_BYTES);
        expect(codeOf(await client.voice.transcribe(chat.id, long, {}, signal()))).toBe('voice-clip-too-long');
        expect(ok(await client.voice.transcribe(chat.id, wav(MAX_VOICE_CLIP_MS), {}, signal())).durationMs).toBe(
            MAX_VOICE_CLIP_MS,
        );
    });

    it.each([
        ['not RIFF', new Blob(['RIFX'.padEnd(64, '\0')], { type: 'audio/wav' })],
        ['compressed WAV', wav(100, { format: 3 })],
        ['no data chunk', new Blob([new Uint8Array(44).slice(0, 36)], { type: 'audio/wav' })],
    ])('cannot transcribe %s', async (_, clip) => {
        const { client, chat } = await setup();
        expect(codeOf(await client.voice.transcribe(chat.id, clip, {}, signal()))).toBe('transcription-failed');
    });

    it('answers 404 for an unknown chat and validates the language', async () => {
        const { client, chat } = await setup();
        expect(codeOf(await client.voice.transcribe(ChatId.parse('nowhere'), wav(100), {}, signal()))).toBe(
            'not-found',
        );
        const bad = await client.voice.transcribe(chat.id, wav(100), { language: 'english!' }, signal());
        expect(codeOf(bad)).toBe('validation-failed');
    });

    it('fails, or is unavailable, as the provider lever says, then heals', async () => {
        const { client, controller, chat } = await setup();
        controller.failVoice('transcription-failed');
        expect(codeOf(await client.voice.transcribe(chat.id, wav(100), {}, signal()))).toBe('transcription-failed');
        controller.failVoice('speech-failed');
        ok(await client.voice.transcribe(chat.id, wav(100), {}, signal()));
        controller.failVoice('voice-unavailable');
        expect(codeOf(await client.voice.transcribe(chat.id, wav(100), {}, signal()))).toBe('voice-unavailable');
        controller.failVoice(null);
        ok(await client.voice.transcribe(chat.id, wav(100), {}, signal()));
    });

    it('needs chats.write, and the capability', async () => {
        const { clientWithout, chat } = await setup();
        const reader = clientWithout('chats.write');
        expect(codeOf(await reader.voice.transcribe(chat.id, wav(100), {}, signal()))).toBe('forbidden');
        const plain = createInMemoryEngine();
        expect(codeOf(await plain.client.voice.transcribe(chat.id, wav(100), {}, signal()))).toBe(
            'capability-not-supported',
        );
        expect(DEFAULT_CAPABILITIES).not.toContainEqual(KNOWN_CAPABILITIES.voiceInput);
        expect(DEFAULT_CAPABILITIES).not.toContainEqual(KNOWN_CAPABILITIES.voiceOutput);
    });

    it('keeps no trace of the clip: no audit entry and nothing in the state', async () => {
        const { client, controller, chat } = await setup();
        const auditBefore = ok(await client.audit.list({ limit: 100 }, signal())).items.length;
        const before = controller.inspect().counts;
        ok(await client.voice.transcribe(chat.id, wav(100, { value: 0x41 }), {}, signal()));
        expect(codeOf(await client.voice.transcribe(chat.id, wav(MAX_VOICE_CLIP_MS + 1_000), {}, signal()))).toBe(
            'voice-clip-too-long',
        );
        expect(controller.inspect().counts).toEqual(before);
        expect(ok(await client.audit.list({ limit: 100 }, signal())).items).toHaveLength(auditBefore);
    });
});

describe('voice-output@1 in the in-memory engine', () => {
    async function withMessage(content = 'Ship it to Brno, please.') {
        const context = await setup();
        const sent = ok(await context.client.chats.sendMessage(context.chat.id, { content }, signal()));
        return { ...context, message: sent.message };
    }

    it('reads a completed message aloud as a WAV tone, the first offered format it can make', async () => {
        const { client, chat, message } = await withMessage();
        const audio = ok(
            await client.voice.speak(chat.id, message.id, { formats: ['audio/mpeg', 'audio/wav'] }, signal()),
        );
        expect(audio.type).toBe('audio/wav');
        const bytes = new Uint8Array(await audio.arrayBuffer());
        expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
        expect(bytes.length).toBe(44 + Math.round(8_000 * 0.24) * 2);
    });

    it('refuses formats it cannot make with 415', async () => {
        const { client, chat, message } = await withMessage();
        const refused = await client.voice.speak(
            chat.id,
            message.id,
            { formats: ['audio/mpeg', 'audio/ogg;codecs=opus'] },
            signal(),
        );
        expect(codeOf(refused)).toBe('unsupported-media-type');
        const duplicate = await client.voice.speak(
            chat.id,
            message.id,
            { formats: ['audio/wav', 'audio/wav'] },
            signal(),
        );
        expect(codeOf(duplicate)).toBe('validation-failed');
    });

    it('answers 404 for an unknown chat, an unknown message and a message of another chat', async () => {
        const { client, chat, message } = await withMessage();
        const bob = ok(await client.agents.create({ source: 'Bob' }, signal()));
        const other = ok(await client.chats.create({ agentId: bob.id, title: 'Other' }, signal()));
        const formats = { formats: ['audio/wav' as const] };
        expect(codeOf(await client.voice.speak(ChatId.parse('nowhere'), message.id, formats, signal()))).toBe(
            'not-found',
        );
        expect(codeOf(await client.voice.speak(chat.id, MessageId.parse('nothing'), formats, signal()))).toBe(
            'not-found',
        );
        expect(codeOf(await client.voice.speak(other.id, message.id, formats, signal()))).toBe('not-found');
    });

    it('speaks only completed messages with text, and none too long', async () => {
        const { client, chat, message, entries } = await withMessage();
        const reply = (await entries()).find((entry) => entry.type === 'message' && entry.id !== message.id);
        if (reply?.type !== 'message') throw new Error('Expected a reply');
        expect(reply.status).toBe('streaming');
        const formats = { formats: ['audio/wav' as const] };
        expect(codeOf(await client.voice.speak(chat.id, reply.id, formats, signal()))).toBe('message-not-speakable');
        const long = ok(
            await client.chats.sendMessage(chat.id, { content: 'a'.repeat(MAX_SPEECH_TEXT_LENGTH + 1) }, signal()),
        );
        expect(codeOf(await client.voice.speak(chat.id, long.message.id, formats, signal()))).toBe('speech-too-long');
        const longest = ok(
            await client.chats.sendMessage(chat.id, { content: 'a'.repeat(MAX_SPEECH_TEXT_LENGTH) }, signal()),
        );
        ok(await client.voice.speak(chat.id, longest.message.id, formats, signal()));
    });

    it('fails, or is unavailable, as the provider lever says', async () => {
        const { client, controller, chat, message } = await withMessage();
        const formats = { formats: ['audio/wav' as const] };
        controller.failVoice('speech-failed');
        expect(codeOf(await client.voice.speak(chat.id, message.id, formats, signal()))).toBe('speech-failed');
        controller.failVoice('transcription-failed');
        ok(await client.voice.speak(chat.id, message.id, formats, signal()));
        controller.failVoice('voice-unavailable');
        expect(codeOf(await client.voice.speak(chat.id, message.id, formats, signal()))).toBe('voice-unavailable');
    });

    it('needs chats.read', async () => {
        const { clientWithout, chat, message } = await withMessage();
        const refused = await clientWithout('chats.read').voice.speak(
            chat.id,
            message.id,
            { formats: ['audio/wav'] },
            signal(),
        );
        expect(codeOf(refused)).toBe('forbidden');
    });
});
