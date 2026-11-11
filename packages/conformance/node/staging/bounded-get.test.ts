import { describe, expect, it } from 'vitest';

import { boundedGet } from './bounded-get';

const URL_ = new URL('https://engine.test/');
const options = (overrides: { timeoutMs?: number; signal?: AbortSignal } = {}) => ({
    headers: {},
    maxBytes: 16,
    timeoutMs: overrides.timeoutMs ?? 1000,
    signal: overrides.signal ?? new AbortController().signal,
});

describe('boundedGet', () => {
    it('reads the body and never follows redirects', async () => {
        let init: RequestInit | undefined;
        const fetched = await boundedGet(
            (_input, given) => {
                init = given;
                return Promise.resolve(new Response('hello', { status: 303 }));
            },
            URL_,
            options(),
        );
        expect(init?.redirect).toBe('manual');
        expect(init?.method).toBe('GET');
        expect(fetched.kind === 'response' && [fetched.status, new TextDecoder().decode(fetched.body)]).toEqual([
            303,
            'hello',
        ]);
    });

    it('reads an empty body', async () => {
        const fetched = await boundedGet(() => Promise.resolve(new Response(null, { status: 204 })), URL_, options());
        expect(fetched.kind === 'response' && fetched.body.length).toBe(0);
    });

    it('stops at the size cap', async () => {
        const fetched = await boundedGet(() => Promise.resolve(new Response('x'.repeat(17))), URL_, options());
        expect(fetched).toEqual({ kind: 'failed', reason: 'the body is over 16 bytes' });
    });

    it('names the socket error behind a failed fetch', async () => {
        const failing = () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
        expect(await boundedGet(failing, URL_, options())).toEqual({
            kind: 'failed',
            reason: 'fetch failed (ECONNRESET)',
        });
        const plain = () => Promise.reject(new TypeError('bad'));
        expect(await boundedGet(plain, URL_, options())).toEqual({ kind: 'failed', reason: 'bad' });
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a thrown non-Error, as libraries may
        const odd = () => Promise.reject('odd');
        expect(await boundedGet(odd, URL_, options())).toEqual({ kind: 'failed', reason: 'odd' });
    });

    it('gives up after the timeout, but reports the caller’s abort as such', async () => {
        const hanging = (_input: unknown, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (signal?.aborted === true) reject(signal.reason as Error);
                signal?.addEventListener('abort', () => {
                    reject(signal.reason as Error);
                });
            });
        expect(await boundedGet(hanging, URL_, options({ timeoutMs: 10 }))).toEqual({
            kind: 'failed',
            reason: 'no answer within 10 ms',
        });
        const aborted = await boundedGet(hanging, URL_, options({ signal: AbortSignal.abort(new Error('stopped')) }));
        expect(aborted).toEqual({ kind: 'failed', reason: 'stopped' });
    });
});
