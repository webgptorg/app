import { readFileSync } from 'node:fs';

import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { CERTSPOTTER_MAX_PAGES, createCertSpotterSource } from './certspotter-source';

const DOMAIN = Hostname.parse('engines.ptbk.test');
const FIXTURE = readFileSync(new URL('fixtures/certspotter-engines.json', import.meta.url).pathname, 'utf8');
const signal = new AbortController().signal;

function source(pages: readonly (() => Response)[], apiKey: string | null = null) {
    const calls: { url: string; init: RequestInit }[] = [];
    const adapter = createCertSpotterSource({
        userAgent: 'test-agent',
        apiKey,
        fetch: (url, init) => {
            calls.push({ url, init });
            const page = pages[calls.length - 1] ?? (() => Response.json([]));
            return Promise.resolve(page());
        },
    });
    return { adapter, calls };
}

describe('createCertSpotterSource (recorded fixture)', () => {
    it('pages through issuances after the cursor and returns the last ID as the next cursor', async () => {
        const { adapter, calls } = source([() => new Response(FIXTURE)]);
        const page = await adapter.read(DOMAIN, '7300000100', signal);
        expect(calls.map((call) => call.url)).toEqual([
            'https://api.certspotter.com/v1/issuances?domain=engines.ptbk.test&include_subdomains=true&expand=dns_names&expand=issuer&after=7300000100',
            'https://api.certspotter.com/v1/issuances?domain=engines.ptbk.test&include_subdomains=true&expand=dns_names&expand=issuer&after=7300000103',
        ]);
        expect(calls[0]?.init.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'test-agent' });
        expect(page.cursor).toBe('7300000103');
        expect(page.issuances).toEqual([
            {
                hostnames: ['k3v6xq2mfz4pd7h5wn2rbtcayu.engines.ptbk.test'],
                issuer: "C=US, O=Let's Encrypt, CN=R11",
                notBefore: Date.UTC(2026, 9, 20, 7),
            },
            {
                hostnames: ['*.engines.ptbk.test'],
                issuer: "C=US, O=Let's Encrypt, CN=E6",
                notBefore: Date.UTC(2026, 9, 21, 9, 12),
            },
            {
                hostnames: ['abcdefghijklmnopqrstuvwxyz.engines.ptbk.test', 'agents.customer.example'],
                issuer: "C=US, O=Let's Encrypt, CN=R11",
                notBefore: Date.UTC(2026, 9, 22, 12, 30),
            },
        ]);
    });

    it('starts from the beginning without a cursor, sends the API key, and stops after a bounded number of pages', async () => {
        const { adapter, calls } = source(
            Array.from({ length: CERTSPOTTER_MAX_PAGES + 2 }, () => () => new Response(FIXTURE)),
            'k3y',
        );
        const page = await adapter.read(DOMAIN, null, signal);
        expect(calls).toHaveLength(CERTSPOTTER_MAX_PAGES);
        expect(calls[0]?.url).not.toContain('after=');
        expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer k3y' });
        expect(page.issuances).toHaveLength(3 * CERTSPOTTER_MAX_PAGES);
        expect(await source([]).adapter.read(DOMAIN, null, signal)).toEqual({ issuances: [], cursor: null });
    });

    it.each([
        ['a rate limit', () => new Response('slow down', { status: 429 })],
        ['an unexpected shape', () => Response.json({ issuances: [] })],
        ['too large an answer', () => new Response(new Uint8Array(4 * 1024 * 1024 + 1))],
    ])('fails on %s', async (_, answer) => {
        await expect(source([answer]).adapter.read(DOMAIN, null, signal)).rejects.toMatchObject({
            name: 'CtSourceError',
        });
    });
});
