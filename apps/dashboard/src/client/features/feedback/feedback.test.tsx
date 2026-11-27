import { render, waitFor } from '@testing-library/react';
import type { Config, FeedbackPayload } from 'ucho-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '../../../paraglide/runtime';
import { session } from '../../testing/fixtures';
import { SessionProvider } from '../session/use-session';
import { feedbackConfig, feedbackPayload } from './feedback';
import { feedbackEndpoint, underAutomation } from './feedback-gate';
import { FeedbackWidget } from './feedback-widget';

const uchoInit = vi.hoisted(() => vi.fn<(config: Config) => () => void>());
vi.mock('ucho-js', () => ({ init: uchoInit }));

const PROJECT = '7f0d7f3c-2127-4b53-836e-0f7dcd43af1a';
const ENDPOINT = `https://clientcare.contember.com/ucho/project/${PROJECT}/task`;
const SENDER = { email: 'ada@example.test', userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', orgId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' };
const SENDER_INPUTS = { senderEmail: SENDER.email, senderUserId: SENDER.userId, senderOrgId: SENDER.orgId };

function sentBody(fetchMock: { mock: { calls: Parameters<typeof fetch>[] } }): unknown {
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    return JSON.parse(typeof body === 'string' ? body : '');
}

function payload(): FeedbackPayload {
    return {
        message: 'The engine list is slow',
        screenshot: 'data:image/jpeg;base64,AAAA',
        customInputs: { area: 'engines' },
        metadata: {
            userAgent: 'test',
            browserInfo: {} as FeedbackPayload['metadata']['browserInfo'],
            networkInfo: {},
            locationInfo: {
                url: 'https://app.ptbk.io/engines/new?code=ABCD-1234',
                origin: 'https://app.ptbk.io',
                pathname: '/engines/new',
                searchParams: { code: 'ABCD-1234' },
                referrer: 'https://app.ptbk.io/link?from=mail#LINK-5678',
            },
            timeInfo: { timezone: 'Europe/Prague', localDateTime: '2026-11-16T12:00:00' },
            console: [{ type: 'log', message: 'opened /link#LINK-5678', timestamp: '2026-11-16T12:00:00Z' }],
        },
    };
}

describe('feedbackEndpoint', () => {
    it('builds the clientcare task URL from a project ID', () => {
        expect(feedbackEndpoint(PROJECT)).toBe(ENDPOINT);
    });

    it('gives no endpoint without a project ID or with a malformed one', () => {
        expect(feedbackEndpoint(undefined)).toBeNull();
        expect(feedbackEndpoint('')).toBeNull();
        expect(feedbackEndpoint('promptbook')).toBeNull();
        expect(feedbackEndpoint(`${PROJECT}/../../admin`)).toBeNull();
    });
});

describe('underAutomation', () => {
    it('is true only when the browser says it is driven by webdriver', () => {
        expect(underAutomation({ webdriver: true })).toBe(true);
        expect(underAutomation({ webdriver: false })).toBe(false);
        expect(underAutomation(undefined)).toBe(false);
    });
});

describe('feedbackPayload', () => {
    it('adds the sender after the message and as custom inputs', () => {
        const sent = feedbackPayload(payload(), SENDER);
        expect(sent.message).toBe(
            'The engine list is slow\n\n— [dashboard] ada@example.test · user aaaaaaaaaaaaaaaaaaaaaaaaaa · org bbbbbbbbbbbbbbbbbbbbbbbbbb',
        );
        expect(sent.customInputs).toEqual({
            area: 'engines',
            senderEmail: 'ada@example.test',
            senderUserId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
            senderOrgId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
        });
        expect(sent.screenshot).toBe('data:image/jpeg;base64,AAAA');
    });

    it('drops queries, fragments and the console buffer, which can carry one-time codes', () => {
        const sent = feedbackPayload(payload(), SENDER);
        expect(sent.metadata.locationInfo.url).toBe('https://app.ptbk.io/engines/new');
        expect(sent.metadata.locationInfo.searchParams).toEqual({});
        expect(sent.metadata.locationInfo.referrer).toBe('https://app.ptbk.io/link');
        expect(sent.metadata.console).toEqual([]);
        expect(JSON.stringify(sent)).not.toMatch(/ABCD-1234|LINK-5678|from=mail/);
    });

    it('sends no referrer it cannot parse', () => {
        const data = payload();
        const sent = feedbackPayload(
            { ...data, metadata: { ...data.metadata, locationInfo: { ...data.metadata.locationInfo, referrer: '' } } },
            SENDER,
        );
        expect(sent.metadata.locationInfo.referrer).toBe('');
    });
});

describe('feedbackConfig', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts the payload with the sender as JSON to the endpoint', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);
        await feedbackConfig(ENDPOINT, () => SENDER).onSubmit?.(payload());
        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(url).toBe(ENDPOINT);
        expect(init?.method).toBe('POST');
        expect(sentBody(fetchMock)).toEqual(JSON.parse(JSON.stringify(feedbackPayload(payload(), SENDER))));
    });

    it('speaks the current locale', () => {
        void setLocale('cs', { reload: false });
        expect(feedbackConfig(ENDPOINT, () => SENDER).textConfig?.feedbackForm?.submitButton).toBe(
            'Odeslat zpětnou vazbu',
        );
        void setLocale('en', { reload: false });
        expect(feedbackConfig(ENDPOINT, () => SENDER).textConfig?.feedbackForm?.submitButton).toBe('Send feedback');
    });
});

describe('FeedbackWidget', () => {
    const cleanup = vi.fn();

    beforeEach(() => {
        uchoInit.mockReset().mockReturnValue(cleanup);
        cleanup.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function renderWidget(project: string | undefined) {
        return render(
            <SessionProvider session={session()}>
                <FeedbackWidget project={project} />
            </SessionProvider>,
        );
    }

    it('starts ucho with the signed-in sender and removes it on unmount', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);
        const view = renderWidget(PROJECT);
        await waitFor(() => {
            expect(uchoInit).toHaveBeenCalledOnce();
        });
        await uchoInit.mock.calls[0]?.[0].onSubmit?.(payload());
        expect(sentBody(fetchMock)).toMatchObject({ customInputs: SENDER_INPUTS });
        view.unmount();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('starts nothing when the build sets no project', async () => {
        renderWidget(undefined);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(uchoInit).not.toHaveBeenCalled();
    });

    it('starts nothing under browser automation', async () => {
        Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true });
        try {
            renderWidget(PROJECT);
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(uchoInit).not.toHaveBeenCalled();
        } finally {
            Reflect.deleteProperty(navigator, 'webdriver');
        }
    });

    it('starts nothing when unmounted before ucho has loaded', async () => {
        renderWidget(PROJECT).unmount();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(uchoInit).not.toHaveBeenCalled();
    });
});
