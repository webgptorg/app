import { describe, expect, it } from 'vitest';

import { actorFromOptions, createInMemoryEngineCore } from '../in-memory-client';
import { ENGINE_API_ROUTES } from '../routes';
import { KNOWN_CAPABILITIES, RESERVED_CAPABILITIES, isReservedCapability } from './capability';
import { BrowserOrigin, LIVE_AUDIO_FORMATS, OpenBrowserTabBody, OpenLiveAudioBody } from './live';

describe('OpenLiveAudioBody', () => {
    it('takes the known formats once each, in the browser’s order', () => {
        expect(OpenLiveAudioBody.parse({ formats: ['pcm16-24k-mono', 'opus-48k-mono'] }).formats).toEqual([
            'pcm16-24k-mono',
            'opus-48k-mono',
        ]);
    });

    it.each([
        { formats: [] },
        { formats: ['opus-48k-mono', 'opus-48k-mono'] },
        { formats: ['mp3'] },
        { formats: ['opus-48k-mono'], video: true },
        {},
    ])('refuses %j', (body) => {
        expect(OpenLiveAudioBody.safeParse(body).success).toBe(false);
    });
});

describe('BrowserOrigin', () => {
    it.each(['https://example.com', 'https://accounts.example.co.uk', 'https://example.com:8443'])(
        'takes %s',
        (origin) => {
            expect(BrowserOrigin.parse(origin)).toBe(origin);
        },
    );

    it.each([
        'http://example.com',
        'https://example.com/',
        'https://example.com/login',
        'https://Example.com',
        'https://example.com:443',
        'https://user@example.com',
        'chrome://settings',
        'about:blank',
        'example.com',
        '',
    ])('refuses %j', (origin) => {
        expect(BrowserOrigin.safeParse(origin).success).toBe(false);
    });
});

describe('OpenBrowserTabBody', () => {
    it('names a browser or the default one, and nothing else', () => {
        expect(OpenBrowserTabBody.parse({ browser: null, origin: 'https://example.com' }).browser).toBeNull();
        expect(OpenBrowserTabBody.safeParse({ origin: 'https://example.com' }).success).toBe(false);
        expect(
            OpenBrowserTabBody.safeParse({ browser: 'work', origin: 'https://example.com', url: '/login' }).success,
        ).toBe(false);
    });
});

describe('live session routes', () => {
    it('are drafts of their capabilities; the browser tab needs its own permission and step-up', () => {
        expect(ENGINE_API_ROUTES.openLiveAudioSession).toMatchObject({
            capability: RESERVED_CAPABILITIES.liveAudio,
            permission: 'chats.write',
            draft: true,
        });
        expect(ENGINE_API_ROUTES.openBrowserTabSession).toMatchObject({
            capability: RESERVED_CAPABILITIES.browserTab,
            permission: 'browser.control',
            stepUp: true,
            draft: true,
        });
        expect(LIVE_AUDIO_FORMATS.length).toBeGreaterThan(0);
    });

    it('tells reserved capabilities from known ones by ID and version', () => {
        expect(isReservedCapability(RESERVED_CAPABILITIES.liveVideo)).toBe(true);
        expect(isReservedCapability({ id: 'live-audio', version: 2 })).toBe(false);
        expect(isReservedCapability(KNOWN_CAPABILITIES.runs)).toBe(false);
    });

    it.each([[[]], [[RESERVED_CAPABILITIES.liveAudio, RESERVED_CAPABILITIES.browserTab]]])(
        'answer capability-not-supported in the in-memory engine, advertised or not (%#)',
        async (capabilities) => {
            const core = createInMemoryEngineCore({ capabilities });
            const transport = core.transport(actorFromOptions({}));
            const signal = AbortSignal.timeout(5_000);
            const audio = await transport(
                ENGINE_API_ROUTES.openLiveAudioSession,
                { params: { chatId: 'chat-1' }, body: { formats: ['opus-48k-mono'] } },
                signal,
            );
            const tab = await transport(
                ENGINE_API_ROUTES.openBrowserTabSession,
                { body: { browser: null, origin: 'https://example.com' } },
                signal,
            );
            for (const result of [audio, tab]) {
                expect(result).toMatchObject({ kind: 'problem', problem: { code: 'capability-not-supported' } });
            }
        },
    );
});
