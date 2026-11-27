import { ENGINE_API_PREFIX, KNOWN_CAPABILITIES, MAX_VOICE_CLIP_BYTES, supports } from '@ptbk/engine-api';
import { afterEach, describe, expect, it } from 'vitest';

import { RATE_LIMITS } from '../src/domain/rate-limit/rate-limiter';
import type { ApiHarness } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';
import { silentWav } from '../src/testing/wav';

const signal = () => AbortSignal.timeout(10_000);
const harnesses: ApiHarness[] = [];

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.recorder.settled();
        expect(harness.recorder.violations).toEqual([]);
        await harness.close();
    }
});

async function start(voice: boolean) {
    const harness = await createApiHarness({ voice });
    harnesses.push(harness);
    const cookie = harness.signIn({ memberId: harness.ownerId() });
    const owner = harness.client(cookie);
    const chats = await owner.chats.listAll({ limit: 1 }, signal());
    const chat = chats.kind === 'ok' ? chats.data.items[0] : undefined;
    if (chat === undefined) throw new Error('no seeded chat');
    return { harness, cookie, owner, chatId: chat.id };
}

const transcriptions = (chatId: string) => `${HARNESS_ORIGIN}${ENGINE_API_PREFIX}/chats/${chatId}/transcriptions`;

describe('MOCK_VOICE', () => {
    it('is off by default: no voice capability, no microphone, voice routes 404', async () => {
        const { harness, cookie, owner, chatId } = await start(false);
        const engine = await owner.engine.get(signal());
        if (engine.kind !== 'ok') throw new Error('engine');
        expect(supports(engine.data, KNOWN_CAPABILITIES.voiceInput)).toBe(false);
        expect(supports(engine.data, KNOWN_CAPABILITIES.voiceOutput)).toBe(false);
        const response = await harness.fetch(cookie)(transcriptions(chatId), { method: 'POST', body: silentWav() });
        expect(response.headers.get('permissions-policy')).toBe(
            'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        );
        expect([response.status, ((await response.json()) as { code: string }).code]).toEqual([
            404,
            'capability-not-supported',
        ]);
    });

    it('advertises both capabilities, allows the microphone for the engine only, and keeps them across a reset', async () => {
        const { harness, cookie, owner } = await start(true);
        const engine = await owner.engine.get(signal());
        if (engine.kind !== 'ok') throw new Error('engine');
        expect(supports(engine.data, KNOWN_CAPABILITIES.voiceInput)).toBe(true);
        expect(supports(engine.data, KNOWN_CAPABILITIES.voiceOutput)).toBe(true);
        const policy = 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()';
        for (const path of [`${ENGINE_API_PREFIX}/engine`, '/no-such-page', `${ENGINE_API_PREFIX}/nothing-here`]) {
            const response = await harness.fetch(cookie)(`${HARNESS_ORIGIN}${path}`);
            await response.body?.cancel();
            expect(response.headers.get('permissions-policy'), path).toBe(policy);
        }
        await harness.runtime?.reset({ seed: 7, scenario: 'small-team', capabilities: [KNOWN_CAPABILITIES.runs] });
        expect(harness.runtime?.current().capabilities).toEqual([
            KNOWN_CAPABILITIES.runs,
            KNOWN_CAPABILITIES.voiceInput,
            KNOWN_CAPABILITIES.voiceOutput,
        ]);
    });

    it('transcribes into a draft that adds nothing to the chat, and speaks a message as WAV', async () => {
        const { owner, chatId } = await start(true);
        const before = await owner.chats.listEntries(chatId, { limit: 100 }, signal());
        const draft = await owner.voice.transcribe(chatId, silentWav(), { language: 'cs' }, signal());
        expect(draft).toEqual({
            kind: 'ok',
            data: { text: '', language: 'cs', confidence: null, durationMs: 1_000 },
        });
        const after = await owner.chats.listEntries(chatId, { limit: 100 }, signal());
        expect(after).toEqual(before);
        const sent = await owner.chats.sendMessage(chatId, { content: 'Read this aloud.' }, signal());
        if (sent.kind !== 'ok') throw new Error('send');
        const speech = await owner.voice.speak(
            chatId,
            sent.data.message.id,
            { formats: ['audio/mpeg', 'audio/wav'] },
            signal(),
        );
        expect(speech.kind === 'ok' && speech.data.type).toBe('audio/wav');
    });

    it('refuses a clip over the byte cap with 413 before reading it', async () => {
        const { harness, cookie, chatId } = await start(true);
        const response = await harness.fetch(cookie)(transcriptions(chatId), {
            method: 'POST',
            body: new Blob([new Uint8Array(MAX_VOICE_CLIP_BYTES + 1)], { type: 'audio/wav' }),
        });
        expect([response.status, ((await response.json()) as { code: string }).code]).toEqual([
            413,
            'payload-too-large',
        ]);
    });

    it('limits voice requests per client on their own budget', async () => {
        const { harness, cookie, chatId } = await start(true);
        const { limit } = RATE_LIMITS['engine-api-voice-ip'];
        const statuses: number[] = [];
        for (let index = 0; index <= limit; index++) {
            const response = await harness.fetch(cookie)(transcriptions(chatId), {
                method: 'POST',
                body: silentWav(320),
            });
            await response.body?.cancel();
            statuses.push(response.status);
        }
        expect(statuses.slice(0, limit).every((status) => status === 200)).toBe(true);
        expect(statuses.at(-1)).toBe(429);
        const other = await harness.fetch(cookie)(`${HARNESS_ORIGIN}${ENGINE_API_PREFIX}/engine`);
        await other.body?.cancel();
        expect(other.status).toBe(200);
    });
});
