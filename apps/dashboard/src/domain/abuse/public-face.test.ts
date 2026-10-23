import { beforeEach, describe, expect, it } from 'vitest';

import {
    createFakePublicFaceFetcher,
    mockEngineFace,
    type FakePublicFaceFetcher,
} from '../../testing/fake-public-face-fetcher';
import {
    checkPublicFace,
    MOCK_ENGINE_SIGN_IN,
    MOCK_ENGINE_SIGN_IN_FINGERPRINT,
    PUBLIC_FACE_MAX_REDIRECTS,
    publicFaceFingerprint,
} from './public-face';

const HOST = 'k3v6xq2mfz4pd7h5wn2rbtcayu.engines.ptbk.test';
const signal = new AbortController().signal;

describe('checkPublicFace', () => {
    let fetcher: FakePublicFaceFetcher;
    const check = () =>
        checkPublicFace({ fetcher, fingerprints: new Set([MOCK_ENGINE_SIGN_IN_FINGERPRINT]) }, HOST, signal);

    beforeEach(() => {
        fetcher = createFakePublicFaceFetcher();
    });

    it('keeps the default fingerprint in step with the mock engine’s sign-in page', async () => {
        expect(await publicFaceFingerprint(MOCK_ENGINE_SIGN_IN)).toBe(MOCK_ENGINE_SIGN_IN_FINGERPRINT);
    });

    it('matches the mock engine’s sign-in page, following its same-host redirect', async () => {
        for (const [url, answer] of mockEngineFace(HOST)) fetcher.routes.set(url, answer);
        expect(await check()).toEqual({ result: 'match', fingerprint: MOCK_ENGINE_SIGN_IN_FINGERPRINT });
        expect(fetcher.requested).toEqual([`https://${HOST}/`, `https://${HOST}/auth/sign-in`]);
    });

    it('calls any other page a mismatch, with its fingerprint', async () => {
        fetcher.routes.set(`https://${HOST}/`, {
            status: 200,
            contentType: 'text/html',
            body: '<title>Sign in to your bank</title><form>password</form>',
        });
        const result = await check();
        expect(result.result).toBe('mismatch');
        expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(result.fingerprint).not.toBe(MOCK_ENGINE_SIGN_IN_FINGERPRINT);
    });

    it('treats a redirect to another host as a mismatch, and never follows it', async () => {
        fetcher.routes.set(`https://${HOST}/`, { status: 302, location: 'https://phish.example/login' });
        expect((await check()).result).toBe('mismatch');
        expect(fetcher.requested).toEqual([`https://${HOST}/`]);
    });

    it.each([
        ['to plain http on the same host', `http://${HOST}/auth/sign-in`],
        ['to another port', `https://${HOST}:8443/auth/sign-in`],
        ['to an address that does not parse', 'https://[::1'],
    ])('treats a redirect %s as a mismatch', async (_, location) => {
        fetcher.routes.set(`https://${HOST}/`, { status: 301, location });
        expect((await check()).result).toBe('mismatch');
        expect(fetcher.requested).toHaveLength(1);
    });

    it('stops after a bounded number of same-host redirects', async () => {
        for (let hop = 0; hop <= PUBLIC_FACE_MAX_REDIRECTS + 1; hop++) {
            fetcher.routes.set(`https://${HOST}/${hop === 0 ? '' : String(hop)}`, {
                status: 302,
                location: `/${String(hop + 1)}`,
            });
        }
        expect((await check()).result).toBe('mismatch');
        expect(fetcher.requested).toHaveLength(PUBLIC_FACE_MAX_REDIRECTS + 1);
    });

    it('fingerprints a redirect status without a location as the page it is', async () => {
        fetcher.routes.set(`https://${HOST}/`, { status: 304 });
        expect((await check()).result).toBe('mismatch');
    });

    it.each([
        ['no answer', null],
        ['a server error', { status: 502 }],
    ])('calls %s unreachable', async (_, answer) => {
        if (answer !== null) fetcher.routes.set(`https://${HOST}/`, answer);
        expect(await check()).toEqual({ result: 'unreachable', fingerprint: null });
    });
});
