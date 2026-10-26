import { describe, expect, it } from 'vitest';

import { PUBLIC_FACE_MAX_BODY_BYTES } from '../../domain/abuse/public-face';
import { createFetchPublicFaceFetcher } from './fetch-public-face-fetcher';

const signal = new AbortController().signal;

function fetcher(answer: () => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const adapter = createFetchPublicFaceFetcher({
        userAgent: 'PromptbookPublicFaceCheck/1',
        fetch: (url, init) => {
            calls.push({ url, init });
            return Promise.resolve(answer());
        },
    });
    return { adapter, calls };
}

describe('createFetchPublicFaceFetcher', () => {
    it('asks as an anonymous visitor: no cookie, no credentials, redirects returned rather than followed', async () => {
        const { adapter, calls } = fetcher(
            () => new Response(null, { status: 303, headers: { Location: '/auth/sign-in' } }),
        );
        expect(await adapter.get('https://e.engines.ptbk.test/', signal)).toEqual({
            status: 303,
            location: '/auth/sign-in',
            contentType: null,
            body: '',
        });
        expect(calls).toEqual([
            {
                url: 'https://e.engines.ptbk.test/',
                init: {
                    method: 'GET',
                    headers: { Accept: 'text/html', 'User-Agent': 'PromptbookPublicFaceCheck/1' },
                    redirect: 'manual',
                    signal,
                },
            },
        ]);
    });

    it('reads only the start of the body', async () => {
        const page = `<title>Sign in</title>${'x'.repeat(PUBLIC_FACE_MAX_BODY_BYTES * 2)}`;
        const { adapter } = fetcher(() => new Response(page, { headers: { 'Content-Type': 'text/html' } }));
        const response = await adapter.get('https://e.engines.ptbk.test/', signal);
        expect(response.contentType).toBe('text/html');
        expect(response.body).toHaveLength(PUBLIC_FACE_MAX_BODY_BYTES);
        expect(response.body.startsWith('<title>Sign in</title>')).toBe(true);
    });

    it('reads a short body whole', async () => {
        const { adapter } = fetcher(() => new Response('<title>Hi</title>'));
        expect((await adapter.get('https://e.engines.ptbk.test/', signal)).body).toBe('<title>Hi</title>');
    });
});
