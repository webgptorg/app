import { describe, expect, it } from 'vitest';

import { actorFromOptions, createInMemoryEngineCore } from '../in-memory-client';
import { ENGINE_API_ROUTES, ENGINE_API_ROUTE_LIST } from '../routes';
import { KNOWN_CAPABILITIES, RESERVED_CAPABILITIES, isReservedCapability } from './capability';
import {
    BrowserHelpRequest,
    BrowserOrigin,
    BrowserSession,
    BrowserTab,
    LIVE_AUDIO_FORMATS,
    OpenBrowserSignInBody,
    OpenLiveAudioBody,
} from './live';

const AT = '2026-11-20T10:00:00.000Z';
const SESSION = {
    id: 'live-1',
    kind: 'agent-tab',
    tabId: 'tab-1',
    browser: 'default',
    mode: 'watching',
    origin: 'https://example.com',
    status: 'open',
    endReason: null,
    helpRequestId: null,
    openedAt: AT,
    attachBy: AT,
    endsAt: AT,
};
const REQUEST = {
    id: 'help-1',
    tabId: 'tab-1',
    agentId: 'agent-1',
    chatId: 'chat-1',
    taskId: null,
    runId: 'run-1',
    reason: 'captcha',
    origin: 'https://example.com',
    message: 'A captcha blocks the checkout.',
    status: 'resolved',
    resolution: { outcome: 'handed-back', origin: 'https://example.com', by: 'member-owner', at: AT },
    createdAt: AT,
    updatedAt: AT,
};

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

describe('OpenBrowserSignInBody', () => {
    it('names a browser or the default one, and nothing else', () => {
        expect(OpenBrowserSignInBody.parse({ browser: null, origin: 'https://example.com' }).browser).toBeNull();
        expect(OpenBrowserSignInBody.safeParse({ origin: 'https://example.com' }).success).toBe(false);
        expect(
            OpenBrowserSignInBody.safeParse({ browser: 'work', origin: 'https://example.com', url: '/login' }).success,
        ).toBe(false);
    });
});

describe('browser resources', () => {
    it('are strict on the engine side', () => {
        expect(BrowserSession.parse(SESSION)).toEqual(SESSION);
        expect(BrowserSession.safeParse({ ...SESSION, url: 'https://example.com/login' }).success).toBe(false);
        expect(BrowserSession.safeParse({ ...SESSION, origin: 'https://example.com/login' }).success).toBe(false);
        expect(BrowserHelpRequest.parse(REQUEST)).toEqual(REQUEST);
        expect(BrowserHelpRequest.safeParse({ ...REQUEST, reason: 'password' }).success).toBe(false);
        expect(BrowserHelpRequest.safeParse({ ...REQUEST, message: 'x'.repeat(501) }).success).toBe(false);
        expect(
            BrowserTab.safeParse({
                id: 'tab-1',
                browser: 'default',
                agentId: null,
                chatId: null,
                taskId: null,
                runId: null,
                origin: null,
                agentState: 'working',
                participants: 0,
                helpRequestId: null,
                openedAt: AT,
            }).success,
        ).toBe(true);
    });

    it('read a newer engine’s values as unknown and drop unknown fields', () => {
        const read = ENGINE_API_ROUTES.getBrowserSession.responses[200].read.parse({
            ...SESSION,
            mode: 'co-driving',
            status: 'paused',
            kind: 'shared-tab',
            endReason: 'crashed',
            extra: 1,
        });
        expect(read).toMatchObject({ mode: 'unknown', status: 'unknown', kind: 'unknown', endReason: 'unknown' });
        expect(read).not.toHaveProperty('extra');
        const help = ENGINE_API_ROUTES.getBrowserHelpRequest.responses[200].read.parse({
            ...REQUEST,
            reason: 'two-factor',
            status: 'escalated',
            resolution: { ...REQUEST.resolution, outcome: 'timed-out' },
        });
        expect(help).toMatchObject({ reason: 'unknown', status: 'unknown', resolution: { outcome: 'unknown' } });
    });
});

describe('live session routes', () => {
    it('are drafts of browser-tab@1 with their own permissions; taking control and signing in need step-up', () => {
        const routes = ENGINE_API_ROUTE_LIST.filter((route) => route.capability === KNOWN_CAPABILITIES.browserTab);
        expect(routes.map((route) => route.id).sort()).toEqual([
            'controlBrowserTab',
            'dismissBrowserHelpRequest',
            'endBrowserSession',
            'getBrowserHelpRequest',
            'getBrowserSession',
            'handBackBrowserTab',
            'listBrowserHelpRequests',
            'listBrowserTabs',
            'openBrowserSignIn',
            'takeBrowserControl',
            'watchBrowserTab',
        ]);
        for (const route of routes) {
            expect(route.draft, route.id).toBe(true);
            expect(['browser.watch', 'browser.control'], route.id).toContain(route.permission);
        }
        const stepUp = routes.filter((route) => route.stepUp === true).map((route) => route.id);
        expect(stepUp.sort()).toEqual(['controlBrowserTab', 'openBrowserSignIn', 'takeBrowserControl']);
        expect(ENGINE_API_ROUTES.openLiveAudioSession).toMatchObject({
            capability: RESERVED_CAPABILITIES.liveAudio,
            permission: 'chats.write',
            draft: true,
        });
        expect(LIVE_AUDIO_FORMATS.length).toBeGreaterThan(0);
    });

    it('tells reserved capabilities from known ones by ID and version', () => {
        expect(isReservedCapability(RESERVED_CAPABILITIES.liveVideo)).toBe(true);
        expect(isReservedCapability(KNOWN_CAPABILITIES.browserTab)).toBe(false);
        expect(isReservedCapability({ id: 'live-audio', version: 2 })).toBe(false);
        expect(isReservedCapability(KNOWN_CAPABILITIES.runs)).toBe(false);
    });

    it.each([[[]], [[RESERVED_CAPABILITIES.liveAudio]]])(
        'answer live audio with capability-not-supported in the in-memory engine, advertised or not (%#)',
        async (capabilities) => {
            const core = createInMemoryEngineCore({ capabilities });
            const result = await core.transport(actorFromOptions({}))(
                ENGINE_API_ROUTES.openLiveAudioSession,
                { params: { chatId: 'chat-1' }, body: { formats: ['opus-48k-mono'] } },
                AbortSignal.timeout(5_000),
            );
            expect(result).toMatchObject({ kind: 'problem', problem: { code: 'capability-not-supported' } });
        },
    );
});
