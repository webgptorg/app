import { MAX_SPEECH_TEXT_LENGTH, MAX_TRANSCRIPT_LENGTH, MAX_VOICE_CLIP_MS } from '../capabilities/voice';
import type { SpeechFormat, TranscriptDraft, VoiceClipFormat } from '../capabilities/voice';
import { fail, notFound, ok } from './kit';
import type { Handlers } from './kit';

/** A lever: the engine's speech provider fails this way until cleared. `voice-unavailable` stops both directions. */
export type VoiceFault = 'transcription-failed' | 'speech-failed' | 'voice-unavailable';

export interface InMemoryVoice {
    fault: VoiceFault | null;
    /** Clip SHA-256 (lowercase hex) to the text the fake hears in it; other clips get one of `FAKE_TRANSCRIPTS`. */
    readonly transcripts: Map<string, string>;
}

export function createVoiceRecord(): InMemoryVoice {
    return { fault: null, transcripts: new Map() };
}

/** What the fake transcriber hears in a clip it was not told about, picked by the clip's hash. */
export const FAKE_TRANSCRIPTS = [
    'What is on my calendar for tomorrow?',
    'Summarise the last report for me, please.',
    'Remind me to call the bakery at three.',
    'Draft a short reply that says I agree.',
] as const;

/** Real engines decode the clip; the fake assumes the UI's Opus bitrate for the containers it cannot decode. */
const FAKE_OPUS_BYTES_PER_SECOND = 32_000 / 8;
/** The fake TTS answers only in WAV, so a browser that offers none gets 415 like from any engine. */
const FAKE_SPEECH_FORMATS: readonly SpeechFormat[] = ['audio/wav'];
const TONE_SAMPLE_RATE = 8_000;
const TONE_HZ = 440;
const TONE_MS_PER_CHARACTER = 10;
const TONE_MAX_MS = 3_000;

type Decoded =
    { readonly kind: 'ok'; readonly durationMs: number; readonly silent: boolean } | { readonly kind: 'unreadable' };

const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53];

function ascii(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** Reads a RIFF/WAVE header: PCM only, the `data` chunk's length over the byte rate. */
function decodeWav(bytes: Uint8Array): Decoded {
    if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') return { kind: 'unreadable' };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let byteRate = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const id = ascii(bytes, offset);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) {
            if (view.getUint16(body, true) !== 1) return { kind: 'unreadable' };
            byteRate = view.getUint32(body + 8, true);
        } else if (id === 'data') {
            if (byteRate === 0) return { kind: 'unreadable' };
            const samples = bytes.subarray(body, Math.min(body + size, bytes.length));
            return {
                kind: 'ok',
                durationMs: Math.round((samples.length * 1000) / byteRate),
                silent: samples.every((byte) => byte === 0),
            };
        }
        offset = body + size + (size % 2);
    }
    return { kind: 'unreadable' };
}

/** Checks the container's magic only; the duration is the fake's estimate at the UI's bitrate. */
function decodeOpus(bytes: Uint8Array, magic: readonly number[]): Decoded {
    if (!magic.every((byte, index) => bytes[index] === byte)) return { kind: 'unreadable' };
    return { kind: 'ok', durationMs: Math.round((bytes.length * 1000) / FAKE_OPUS_BYTES_PER_SECOND), silent: false };
}

function decode(format: VoiceClipFormat, bytes: Uint8Array): Decoded {
    switch (format) {
        case 'audio/wav':
            return decodeWav(bytes);
        case 'audio/webm;codecs=opus':
            return decodeOpus(bytes, WEBM_MAGIC);
        case 'audio/ogg;codecs=opus':
            return decodeOpus(bytes, OGG_MAGIC);
    }
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A mono 16-bit PCM WAV of a quiet sine, as long as the text would roughly take to say, capped to stay tiny. */
export function toneWav(characters: number): Uint8Array<ArrayBuffer> {
    const durationMs = Math.min(TONE_MAX_MS, Math.max(200, characters * TONE_MS_PER_CHARACTER));
    const samples = Math.round((TONE_SAMPLE_RATE * durationMs) / 1000);
    const bytes = new Uint8Array(44 + samples * 2);
    const view = new DataView(bytes.buffer);
    const write = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, TONE_SAMPLE_RATE, true);
    view.setUint32(28, TONE_SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, samples * 2, true);
    for (let index = 0; index < samples; index++) {
        const sample = Math.sin((2 * Math.PI * TONE_HZ * index) / TONE_SAMPLE_RATE) * 0.2;
        view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true);
    }
    return bytes;
}

/**
 * The reference behaviour of `voice-input@1` and `voice-output@1` with a deterministic fake provider. The clip lives
 * only in this request: nothing about it is stored, logged, audited or announced, and a transcript adds no entry.
 */
export const VOICE_HANDLERS: Pick<Handlers, 'transcribeVoiceClip' | 'speakChatMessage'> = {
    transcribeVoiceClip: async ({ params, query, body }, ctx) => {
        if (!ctx.state.chats.has(params.chatId)) return notFound('chat');
        const { voice } = ctx.state;
        if (voice.fault === 'voice-unavailable') return fail('voice-unavailable');
        const bytes = new Uint8Array(await body.arrayBuffer());
        const decoded = decode(body.type as VoiceClipFormat, bytes);
        if (decoded.kind === 'unreadable') return fail('transcription-failed');
        if (decoded.durationMs > MAX_VOICE_CLIP_MS) return fail('voice-clip-too-long');
        if (voice.fault === 'transcription-failed') return fail('transcription-failed');
        const hash = await sha256Hex(bytes);
        const heard =
            voice.transcripts.get(hash) ??
            (decoded.silent ? '' : FAKE_TRANSCRIPTS[Number.parseInt(hash.slice(0, 8), 16) % FAKE_TRANSCRIPTS.length]);
        const draft: TranscriptDraft = {
            text: (heard ?? '').slice(0, MAX_TRANSCRIPT_LENGTH),
            language: query.language ?? 'en',
            confidence: heard === '' ? null : 0.92,
            durationMs: decoded.durationMs,
        };
        return ok(draft);
    },
    speakChatMessage: ({ params, body }, ctx) => {
        if (!ctx.state.chats.has(params.chatId)) return notFound('chat');
        const message = ctx.state.messages.get(params.messageId);
        if (message?.chatId !== params.chatId) return notFound('message');
        if (message.status !== 'completed' || message.content.trim() === '') return fail('message-not-speakable');
        if (message.content.length > MAX_SPEECH_TEXT_LENGTH) return fail('speech-too-long');
        const format = body.formats.find((candidate) => FAKE_SPEECH_FORMATS.includes(candidate));
        if (format === undefined) return fail('unsupported-media-type');
        const { fault } = ctx.state.voice;
        if (fault === 'voice-unavailable' || fault === 'speech-failed') return fail(fault);
        return ok(new Blob([toneWav(message.content.length)], { type: format }));
    },
};
