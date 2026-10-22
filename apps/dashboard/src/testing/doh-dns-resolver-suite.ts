import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createDohDnsResolver, DOH_ENDPOINT } from '../adapters/dns/doh-dns-resolver';

const HOSTNAME = Hostname.parse('agents.customer.example');
const TARGET = 'abcdefghijklmnopqrstuvwxyz.engines.ptbk.test';
const signal = new AbortController().signal;

function answering(body: unknown, init: ResponseInit = {}) {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const resolver = createDohDnsResolver({
        fetch: (input, requestInit) => {
            calls.push({ url: input instanceof Request ? input.url : input.toString(), init: requestInit });
            const text = typeof body === 'string' ? body : JSON.stringify(body);
            return Promise.resolve(
                new Response(text, { headers: { 'Content-Type': 'application/dns-json' }, ...init }),
            );
        },
    });
    return { resolver, calls };
}

const cname = (name: string, data: string) => ({ name, type: 5, TTL: 300, data });

/** Run under Node (unit) and workerd (workers), so the abort, timeout and redirect handling hold in production. */
export function describeDohDnsResolver(runtime: string): void {
    describe(`createDohDnsResolver on ${runtime}`, () => {
        it('asks the JSON API for the CNAME record, without following redirects', async () => {
            const { resolver, calls } = answering({ Status: 0, Answer: [cname(`${HOSTNAME}.`, `${TARGET}.`)] });
            await resolver.resolveCname(HOSTNAME, signal);
            expect(calls).toHaveLength(1);
            expect(calls[0]?.url).toBe(`${DOH_ENDPOINT}?name=agents.customer.example&type=CNAME`);
            expect(calls[0]?.init?.headers).toEqual({ accept: 'application/dns-json' });
            expect(calls[0]?.init?.redirect).toBe('manual');
        });

        it('answers the target of exactly one CNAME, lowercased without the trailing dot', async () => {
            const { resolver } = answering({
                Status: 0,
                TC: false,
                Question: [{ name: HOSTNAME, type: 5 }],
                Answer: [cname('Agents.Customer.Example.', `${TARGET.toUpperCase()}.`)],
            });
            expect(await resolver.resolveCname(HOSTNAME, signal)).toEqual({ kind: 'cname', target: TARGET });
        });

        it.each([
            ['NXDOMAIN', { Status: 3 }],
            ['no answer', { Status: 0 }],
            ['an empty answer', { Status: 0, Answer: [] }],
            ['two CNAMEs', { Status: 0, Answer: [cname(HOSTNAME, TARGET), cname(HOSTNAME, `x.${TARGET}`)] }],
            ['a CNAME of another name only', { Status: 0, Answer: [cname('other.customer.example', TARGET)] }],
            ['an A record only', { Status: 0, Answer: [{ name: HOSTNAME, type: 1, TTL: 60, data: '192.0.2.1' }] }],
            ['a target that is no hostname', { Status: 0, Answer: [cname(HOSTNAME, '192.0.2.1')] }],
        ])('answers none for %s', async (_, body) => {
            expect(await answering(body).resolver.resolveCname(HOSTNAME, signal)).toEqual({ kind: 'none' });
        });

        it.each([
            ['SERVFAIL', { Status: 2 }, {}],
            ['an HTTP error', { Status: 0 }, { status: 503 }],
            ['a redirect', { Status: 0 }, { status: 302, headers: { Location: 'https://elsewhere.example/' } }],
            ['a body that is not JSON', 'not json', {}],
            ['a body of the wrong shape', { Status: 'ok' }, {}],
            ['an oversized body', { Status: 0, padding: 'x'.repeat(70_000) }, {}],
        ])('answers error for %s', async (_, body, init: ResponseInit) => {
            expect(await answering(body, init).resolver.resolveCname(HOSTNAME, signal)).toEqual({ kind: 'error' });
        });

        it('answers error when the request fails or outlasts the timeout', async () => {
            const failing = createDohDnsResolver({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
            expect(await failing.resolveCname(HOSTNAME, signal)).toEqual({ kind: 'error' });
            const hanging = createDohDnsResolver({
                timeoutMs: 5,
                fetch: (_, init) =>
                    new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => {
                            reject(init.signal?.reason as Error);
                        });
                    }),
            });
            expect(await hanging.resolveCname(HOSTNAME, signal)).toEqual({ kind: 'error' });
        });

        it('rejects with the caller abort reason, before and during the request', async () => {
            const { resolver, calls } = answering({ Status: 0 });
            const aborted = new AbortController();
            aborted.abort(new Error('gone'));
            await expect(resolver.resolveCname(HOSTNAME, aborted.signal)).rejects.toThrow('gone');
            expect(calls).toHaveLength(0);
            const during = new AbortController();
            const pending = createDohDnsResolver({
                fetch: (_, init) =>
                    new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => {
                            reject(new Error('aborted fetch'));
                        });
                    }),
            }).resolveCname(HOSTNAME, during.signal);
            during.abort(new Error('left'));
            await expect(pending).rejects.toThrow('left');
        });
    });
}
