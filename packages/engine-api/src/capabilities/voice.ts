import { z } from 'zod';

import { ChatMessageParams, ChatParams } from '../chats';
import { defineRoute } from '../route';
import { KNOWN_CAPABILITIES } from './capability';

/**
 * Voice phase 1 (issue #332): push-to-talk and spoken replies, two separate capabilities so an engine can offer one
 * without the other. Both are ordinary engine API requests inside the engine's TLS; relays and the dashboard never see
 * audio or text. Speech-to-text and text-to-speech run on the engine or its harness's provider. Full-duplex voice is
 * `live-audio@1` over the live channel, still reserved. Design and rationale: docs/engine-integration/voice.md.
 */

/**
 * What the browser may upload, as normalised `Content-Type` values (`normalizeMediaType`). WebM and Ogg with Opus are
 * what `MediaRecorder` produces in Chromium and Firefox; WAV (16-bit PCM, mono, 16 kHz from the UI) is the fallback any
 * browser can produce without a codec, Safari included. All three go to common speech-to-text providers unchanged.
 */
export const VOICE_CLIP_FORMATS = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/wav'] as const;
export type VoiceClipFormat = (typeof VOICE_CLIP_FORMATS)[number];

/**
 * 60 seconds of the WAV fallback is 1,920,044 bytes, so 2 MiB holds the longest clip in the largest format; Opus at
 * the UI's 32 kbit/s needs about 240 KB. The engine refuses more before it reads the body.
 */
export const MAX_VOICE_CLIP_BYTES = 2 * 1024 * 1024;
/**
 * Push-to-talk is for one message, not dictation: longer is 422 `voice-clip-too-long`. Measured by decoding the clip,
 * since `MediaRecorder`'s WebM states no duration.
 */
export const MAX_VOICE_CLIP_MS = 60_000;
/** A minute of fast speech is about 1,500 characters; the cap leaves room for languages that write more per word. */
export const MAX_TRANSCRIPT_LENGTH = 4_000;

/** A BCP 47 language tag as providers report it, e.g. `en`, `cs-CZ`, `zh-Hant`. */
export const LanguageTag = z
    .string()
    .max(35)
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

export const TranscriptionQuery = z.strictObject({
    /** The language the member speaks, if the UI knows it; without it the engine or provider detects it. */
    language: LanguageTag.optional(),
});

/** The raw clip; the route's `Content-Type` and size rules apply before this. */
export const VoiceClip = z.instanceof(Blob);

/**
 * A suggestion, never a message: the UI puts `text` into the composer for the member to read and change before they
 * send it through `sendChatMessage`. `text` is model output, rendered as text only. Empty when no speech was heard.
 */
export const TranscriptDraft = z.strictObject({
    text: z.string().max(MAX_TRANSCRIPT_LENGTH),
    /** Detected or as asked; `null` when the provider does not say. */
    language: LanguageTag.nullable(),
    /** The provider's overall confidence from 0 to 1; `null` when it reports none. */
    confidence: z.number().min(0).max(1).nullable(),
    /** The clip's length as the engine decoded it. */
    durationMs: z.int().min(0).max(MAX_VOICE_CLIP_MS),
});
export type TranscriptDraft = z.infer<typeof TranscriptDraft>;

/**
 * What the engine may answer with, as normalised `Content-Type` values. Every browser decodes MP3 and WAV with
 * `AudioContext.decodeAudioData`; Ogg Opus is the smallest where it is supported. The UI plays the answer through
 * Web Audio, never a `blob:` URL, so `ENGINE_UI_CSP` needs no `media-src`.
 */
export const SPEECH_FORMATS = ['audio/mpeg', 'audio/ogg;codecs=opus', 'audio/wav'] as const;
export const SpeechFormat = z.enum(SPEECH_FORMATS);
export type SpeechFormat = z.infer<typeof SpeechFormat>;

/**
 * Longer messages are 422 `speech-too-long`, counted in UTF-16 code units of `content` as the API sends it, so the UI
 * knows before asking. About four minutes of speech, and within what common text-to-speech APIs take in one call.
 */
export const MAX_SPEECH_TEXT_LENGTH = 4_000;

/** The formats the browser can play, in its order of preference; the engine answers in the first it can make. */
export const SpeakMessageBody = z.strictObject({
    formats: z
        .array(SpeechFormat)
        .min(1)
        .max(SPEECH_FORMATS.length)
        .refine((formats) => new Set(formats).size === formats.length, { message: 'Each format may appear once' }),
});
export type SpeakMessageBody = z.infer<typeof SpeakMessageBody>;

export const VOICE_ROUTES = {
    transcribeVoiceClip: defineRoute({
        id: 'transcribeVoiceClip',
        method: 'POST',
        path: '/chats/{chatId}/transcriptions',
        summary: 'Turn a recorded clip into a transcript draft for the composer; nothing is sent or kept',
        description:
            'The body is the clip itself, with its `Content-Type` one of `VOICE_CLIP_FORMATS`. Longer than ' +
            '`MAX_VOICE_CLIP_MS` is 422 `voice-clip-too-long`. The engine keeps no audio and no transcript, logs ' +
            'neither, and adds nothing to the chat: the member sends the edited text as an ordinary message. A ' +
            'provider that fails is 502 `transcription-failed`; none ready right now is 503 `voice-unavailable`.',
        permission: 'chats.write',
        capability: KNOWN_CAPABILITIES.voiceInput,
        params: ChatParams,
        query: TranscriptionQuery,
        body: { kind: 'binary', schema: VoiceClip, mediaTypes: VOICE_CLIP_FORMATS, maxBytes: MAX_VOICE_CLIP_BYTES },
        responses: { 200: { kind: 'json', schema: TranscriptDraft } },
        problems: [
            'payload-too-large',
            'unsupported-media-type',
            'voice-clip-too-long',
            'transcription-failed',
            'voice-unavailable',
        ],
    }),
    speakChatMessage: defineRoute({
        id: 'speakChatMessage',
        method: 'POST',
        path: '/chats/{chatId}/messages/{messageId}/speech',
        summary: 'Read a message aloud: its text as audio in the first offered format the engine can make',
        description:
            'Only a `completed` message with text (409 `message-not-speakable` otherwise), of at most ' +
            '`MAX_SPEECH_TEXT_LENGTH` (422 `speech-too-long`). None of the offered formats is 415 ' +
            '`unsupported-media-type`. The audio is made for this request and neither stored nor cached.',
        permission: 'chats.read',
        capability: KNOWN_CAPABILITIES.voiceOutput,
        params: ChatMessageParams,
        body: { kind: 'json', schema: SpeakMessageBody },
        responses: { 200: { kind: 'binary', mediaTypes: SPEECH_FORMATS } },
        problems: [
            'unsupported-media-type',
            'speech-too-long',
            'message-not-speakable',
            'speech-failed',
            'voice-unavailable',
        ],
    }),
} as const;
