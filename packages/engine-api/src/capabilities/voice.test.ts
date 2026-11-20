import { describe, expect, it } from 'vitest';

import { EngineApiContractError } from '../client';
import { ChatId, MessageId } from '../common';
import { ENGINE_API_PREFIX } from '../constants';
import { createFetchEngineApiClient } from '../fetch-client';
import { createEngineApiHttpHandler } from '../http/serve';
import { DEFAULT_CAPABILITIES, actorFromOptions, createInMemoryEngineCore } from '../in-memory-client';
import { matchMediaType, normalizeMediaType } from '../media-type';
import { buildOpenApiDocument } from '../openapi';
import { ENGINE_API_ROUTES } from '../routes';
import { KNOWN_CAPABILITIES } from './capability';
import {
    LanguageTag,
    MAX_VOICE_CLIP_BYTES,
    SPEECH_FORMATS,
    SpeakMessageBody,
    TranscriptDraft,
    TranscriptionQuery,
    VOICE_CLIP_FORMATS,
} from './voice';

const BASE = 'https://engine.test';
const signal = () => AbortSignal.timeout(5_000);

describe('normalizeMediaType', () => {
    it.each([
        ['audio/wav', 'audio/wav'],
        ['Audio/WAV', 'audio/wav'],
        ['audio/ogg; codecs="opus"', 'audio/ogg;codecs=opus'],
        ['audio/webm;codecs=OPUS', 'audio/webm;codecs=opus'],
        [' audio/webm ; codecs = opus ', 'audio/webm;codecs=opus'],
    ])('reads %j as %j', (value, expected) => {
        expect(normalizeMediaType(value)).toBe(expected);
    });

    it.each(['', 'audio', 'audio/', '/wav', 'audio/wav;', 'audio/wav;codecs', 'audio/ogg;codecs="op"us"', 'a b/c'])(
        'refuses %j',
        (value) => {
            expect(normalizeMediaType(value)).toBeNull();
        },
    );

    it('matches only the listed types, and nothing without a value', () => {
        expect(matchMediaType('audio/ogg; codecs=opus', VOICE_CLIP_FORMATS)).toBe('audio/ogg;codecs=opus');
        expect(matchMediaType('audio/ogg', VOICE_CLIP_FORMATS)).toBeNull();
        expect(matchMediaType('audio/wav;codecs=1', VOICE_CLIP_FORMATS)).toBeNull();
        expect(matchMediaType(null, VOICE_CLIP_FORMATS)).toBeNull();
        expect(matchMediaType(undefined, VOICE_CLIP_FORMATS)).toBeNull();
    });
});

describe('voice schemas', () => {
    it('takes a transcript draft with or without language and confidence, and nothing else', () => {
        const draft = { text: 'Hello', language: 'cs-CZ', confidence: 0.5, durationMs: 1200 };
        expect(TranscriptDraft.parse(draft)).toEqual(draft);
        expect(TranscriptDraft.parse({ ...draft, text: '', language: null, confidence: null }).text).toBe('');
        for (const bad of [
            { ...draft, audio: 'UklGRg' },
            { ...draft, confidence: 1.5 },
            { ...draft, durationMs: 60_001 },
            { ...draft, durationMs: 1.5 },
            { ...draft, text: 'a'.repeat(4_001) },
            { ...draft, language: 'not a tag' },
        ]) {
            expect(TranscriptDraft.safeParse(bad).success).toBe(false);
        }
    });

    it.each(['en', 'cs-CZ', 'zh-Hant-TW', 'gsw'])('takes the language tag %s', (tag) => {
        expect(LanguageTag.parse(tag)).toBe(tag);
    });

    it.each(['e', 'english', 'en_US', 'en-', `en-${'a'.repeat(40)}`])('refuses the language tag %j', (tag) => {
        expect(LanguageTag.safeParse(tag).success).toBe(false);
    });

    it('takes only a language in the transcription query', () => {
        expect(TranscriptionQuery.parse({})).toEqual({});
        expect(TranscriptionQuery.safeParse({ model: 'whisper' }).success).toBe(false);
    });

    it('takes known speech formats once each, in the browser’s order', () => {
        expect(SpeakMessageBody.parse({ formats: ['audio/wav', 'audio/mpeg'] }).formats).toEqual([
            'audio/wav',
            'audio/mpeg',
        ]);
        for (const bad of [
            { formats: [] },
            { formats: ['audio/wav', 'audio/wav'] },
            { formats: ['audio/flac'] },
            { formats: ['audio/wav'], voice: 'alloy' },
        ]) {
            expect(SpeakMessageBody.safeParse(bad).success).toBe(false);
        }
    });

    it('declares both routes on their own capability with the chat permissions', () => {
        expect(ENGINE_API_ROUTES.transcribeVoiceClip).toMatchObject({
            capability: KNOWN_CAPABILITIES.voiceInput,
            permission: 'chats.write',
            body: { kind: 'binary', mediaTypes: VOICE_CLIP_FORMATS, maxBytes: MAX_VOICE_CLIP_BYTES },
        });
        expect(ENGINE_API_ROUTES.speakChatMessage).toMatchObject({
            capability: KNOWN_CAPABILITIES.voiceOutput,
            permission: 'chats.read',
            responses: { 200: { kind: 'binary', mediaTypes: SPEECH_FORMATS } },
        });
        expect(ENGINE_API_ROUTES.transcribeVoiceClip).not.toHaveProperty('draft');
    });

    it('describes the raw body and the typed answer in OpenAPI', () => {
        const document = buildOpenApiDocument() as unknown as {
            paths: Record<string, Record<string, { requestBody: unknown; responses: Record<string, unknown> }>>;
        };
        const transcribe = document.paths['/chats/{chatId}/transcriptions']?.['post'];
        expect(Object.keys((transcribe?.requestBody as { content: object }).content)).toEqual([...VOICE_CLIP_FORMATS]);
        const speak = document.paths['/chats/{chatId}/messages/{messageId}/speech']?.['post'];
        expect(Object.keys((speak?.responses['200'] as { content: object }).content)).toEqual([...SPEECH_FORMATS]);
        const download = document.paths['/files/{fileId}/content']?.['get'];
        expect(Object.keys((download?.responses['200'] as { content: object }).content)).toEqual([
            'application/octet-stream',
        ]);
    });
});

/** The fetch client over the HTTP binding over the in-memory engine: every byte through real `Request`s. */
async function overHttp() {
    const core = createInMemoryEngineCore({
        capabilities: [...DEFAULT_CAPABILITIES, KNOWN_CAPABILITIES.voiceInput, KNOWN_CAPABILITIES.voiceOutput],
    });
    const serve = createEngineApiHttpHandler(core.transport(actorFromOptions({})));
    const client = createFetchEngineApiClient({
        baseUrl: BASE,
        timeoutMs: 5_000,
        fetch: (input, init) => serve(new Request(input, init)),
    });
    const agent = await client.agents.create({ source: 'Ada' }, signal());
    if (agent.kind !== 'ok') throw new Error('no agent');
    const chat = await client.chats.create({ agentId: agent.data.id, title: 'Voice' }, signal());
    if (chat.kind !== 'ok') throw new Error('no chat');
    return { core, serve, client, chatId: chat.data.id };
}

function silentWav(ms: number): Blob {
    const dataBytes = Math.round(16 * ms) * 2;
    const bytes = new Uint8Array(44 + dataBytes);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    view.setUint32(4, 36 + dataBytes, true);
    bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16_000, true);
    view.setUint32(28, 32_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    bytes.set(new TextEncoder().encode('data'), 36);
    view.setUint32(40, dataBytes, true);
    return new Blob([bytes], { type: 'audio/wav' });
}

describe('voice over HTTP', () => {
    it('sends the clip as the raw body with its type, and reads the draft', async () => {
        const { client, chatId } = await overHttp();
        const draft = await client.voice.transcribe(chatId, silentWav(500), { language: 'cs' }, signal());
        expect(draft).toEqual({
            kind: 'ok',
            data: { text: '', language: 'cs', confidence: null, durationMs: 500 },
        });
    });

    it('refuses an unlisted type and an oversize body before the engine reads it', async () => {
        const { serve, chatId } = await overHttp();
        const url = `${BASE}${ENGINE_API_PREFIX}/chats/${chatId}/transcriptions`;
        const post = (body: BodyInit, headers: Record<string, string>) =>
            serve(new Request(url, { method: 'POST', headers, body }));
        expect((await post('x', { 'content-type': 'audio/mpeg' })).status).toBe(415);
        expect((await post('x', {})).status).toBe(415);
        const declared = await post('x', { 'content-type': 'audio/wav', 'content-length': '3000000' });
        expect(declared.status).toBe(413);
        const streamed = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let sent = 0; sent <= MAX_VOICE_CLIP_BYTES; sent += 512 * 1024) {
                    controller.enqueue(new Uint8Array(512 * 1024));
                }
                controller.close();
            },
        });
        const chunked = await serve(
            new Request(url, {
                method: 'POST',
                headers: { 'content-type': 'audio/wav' },
                body: streamed,
                duplex: 'half',
            } as RequestInit),
        );
        expect(chunked.status).toBe(413);
        expect(await chunked.json()).toMatchObject({ code: 'payload-too-large' });
        const empty = await serve(new Request(url, { method: 'POST', headers: { 'content-type': 'audio/wav' } }));
        expect(await empty.json()).toMatchObject({ code: 'transcription-failed' });
    });

    it('answers speech with the chosen format as its type, an attachment the browser does not sniff', async () => {
        const { client, serve, chatId } = await overHttp();
        const sent = await client.chats.sendMessage(chatId, { content: 'Read me.' }, signal());
        if (sent.kind !== 'ok') throw new Error('not sent');
        const audio = await client.voice.speak(chatId, sent.data.message.id, { formats: ['audio/wav'] }, signal());
        expect(audio.kind === 'ok' && audio.data.type).toBe('audio/wav');
        const raw = await serve(
            new Request(
                `${BASE}${ENGINE_API_PREFIX}/chats/${chatId}/messages/${encodeURIComponent(sent.data.message.id)}/speech`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ formats: ['audio/wav'] }),
                },
            ),
        );
        expect(raw.status, await raw.clone().text()).toBe(200);
        expect(raw.headers.get('content-type')).toBe('audio/wav');
        expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
        expect(raw.headers.get('content-disposition')).toBe('attachment');
    });
});

describe('the fetch client with binary routes', () => {
    function client(answer: Response, seen: Request[] = []) {
        return createFetchEngineApiClient({
            baseUrl: BASE,
            timeoutMs: 5_000,
            fetch: (input, init) => {
                seen.push(new Request(input, init));
                return Promise.resolve(answer);
            },
        });
    }
    const chatId = ChatId.parse('c1');
    const messageId = MessageId.parse('c1#1');

    it('asks for the declared formats and refuses an answer in any other', async () => {
        const seen: Request[] = [];
        const wav = new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/WAV' } });
        const audio = await client(wav, seen).voice.speak(chatId, messageId, { formats: ['audio/wav'] }, signal());
        expect(audio.kind === 'ok' && audio.data.type).toBe('audio/wav');
        expect(seen[0]?.headers.get('accept')).toBe(`${SPEECH_FORMATS.join(', ')}, application/problem+json`);
        const html = new Response('<p>', { headers: { 'content-type': 'text/html' } });
        await expect(
            client(html).voice.speak(chatId, messageId, { formats: ['audio/wav'] }, signal()),
        ).rejects.toBeInstanceOf(EngineApiContractError);
    });

    it('sends the Blob’s type and refuses to send anything but a Blob', async () => {
        const seen: Request[] = [];
        const draft = Response.json({ text: 'Hi', language: null, confidence: null, durationMs: 10 });
        await client(draft, seen).voice.transcribe(chatId, silentWav(10), {}, signal());
        expect(seen[0]?.headers.get('content-type')).toBe('audio/wav');
        expect((await seen[0]?.arrayBuffer())?.byteLength).toBe(44 + 320);
        await expect(
            client(Response.json({})).voice.transcribe(chatId, 'RIFF' as unknown as Blob, {}, signal()),
        ).rejects.toThrow(/Blob/);
    });
});
