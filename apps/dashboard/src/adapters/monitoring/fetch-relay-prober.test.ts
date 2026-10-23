import type { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createFetchRelayProber } from './fetch-relay-prober';

const RELAY = 'relay-a.ptbk.test' as Hostname;
const TOKEN = `ptbk_mt_${'m'.repeat(43)}`;
const signal = new AbortController().signal;

type Route = (init: RequestInit) => Response | Promise<Response>;

function prober(routes: Readonly<Record<string, Route>>, tokens = new Map([[RELAY, TOKEN]])) {
    const calls: { url: string; init: RequestInit }[] = [];
    const adapter = createFetchRelayProber({
        tokens,
        fetch: async (url, init) => {
            calls.push({ url, init });
            const route = routes[url];
            if (route === undefined) throw new TypeError('fetch failed');
            return route(init);
        },
    });
    return { adapter, calls };
}

describe('createFetchRelayProber', () => {
    it('checks /healthz, then scrapes /metrics with the bearer token, over https and without redirects', async () => {
        const { adapter, calls } = prober({
            'https://relay-a.ptbk.test/healthz': () => new Response('ok'),
            'https://relay-a.ptbk.test/metrics': () => new Response('ptbk_relay_tunnels_active 1\n'),
        });
        await expect(adapter.probe(RELAY, signal)).resolves.toEqual({
            kind: 'up',
            metrics: 'ptbk_relay_tunnels_active 1\n',
        });
        expect(calls.map((call) => [call.url, call.init.redirect])).toEqual([
            ['https://relay-a.ptbk.test/healthz', 'manual'],
            ['https://relay-a.ptbk.test/metrics', 'manual'],
        ]);
        expect(calls[0]?.init.headers).toEqual({});
        expect(calls[1]?.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    });

    it.each([
        ['a refused connection or handshake', {}, 'tls'],
        ['a wrong health answer', { 'https://relay-a.ptbk.test/healthz': () => new Response('nope') }, 'healthz'],
        [
            'a failing health check',
            { 'https://relay-a.ptbk.test/healthz': () => new Response('ok', { status: 503 }) },
            'healthz',
        ],
        [
            'a refused token',
            {
                'https://relay-a.ptbk.test/healthz': () => new Response('ok'),
                'https://relay-a.ptbk.test/metrics': () => new Response(null, { status: 401 }),
            },
            'metrics',
        ],
        [
            'an oversized scrape',
            {
                'https://relay-a.ptbk.test/healthz': () => new Response('ok'),
                'https://relay-a.ptbk.test/metrics': () => new Response('x'.repeat(300 * 1024)),
            },
            'metrics',
        ],
    ] as const)('reports %s', async (_, routes, reason) => {
        await expect(prober(routes).adapter.probe(RELAY, signal)).resolves.toEqual({ kind: 'down', reason });
    });

    it('cancels the body of a failed health check instead of leaving it unread', async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
        });
        const failing = prober({ 'https://relay-a.ptbk.test/healthz': () => new Response(body, { status: 502 }) });
        await expect(failing.adapter.probe(RELAY, signal)).resolves.toEqual({ kind: 'down', reason: 'healthz' });
        expect(cancelled).toBe(true);
        const empty = prober({ 'https://relay-a.ptbk.test/healthz': () => new Response(null, { status: 502 }) });
        await expect(empty.adapter.probe(RELAY, signal)).resolves.toEqual({ kind: 'down', reason: 'healthz' });
    });

    it('reports an aborted probe as a timeout, a relay without a token as metrics, and an empty body', async () => {
        const controller = new AbortController();
        const slow = prober({
            'https://relay-a.ptbk.test/healthz': () => {
                controller.abort();
                throw new DOMException('aborted', 'AbortError');
            },
        });
        await expect(slow.adapter.probe(RELAY, controller.signal)).resolves.toEqual({
            kind: 'down',
            reason: 'timeout',
        });
        await expect(prober({}, new Map()).adapter.probe(RELAY, signal)).resolves.toEqual({
            kind: 'down',
            reason: 'metrics',
        });
        const empty = prober({
            'https://relay-a.ptbk.test/healthz': () => new Response('ok'),
            'https://relay-a.ptbk.test/metrics': () => new Response(null),
        });
        await expect(empty.adapter.probe(RELAY, signal)).resolves.toEqual({ kind: 'up', metrics: '' });
    });
});
