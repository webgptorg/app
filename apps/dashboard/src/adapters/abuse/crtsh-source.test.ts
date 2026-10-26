import { readFileSync } from 'node:fs';

import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createCrtShSource } from './crtsh-source';

const DOMAIN = Hostname.parse('engines.ptbk.test');
const FIXTURE = readFileSync(new URL('fixtures/crtsh-engines.json', import.meta.url).pathname, 'utf8');
const signal = new AbortController().signal;

function source(answer: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const adapter = createCrtShSource({
        userAgent: 'test-agent',
        fetch: async (url, init) => {
            calls.push({ url, init });
            return answer();
        },
    });
    return { adapter, calls };
}

describe('createCrtShSource (recorded fixture)', () => {
    it('asks for every unexpired certificate under the domain and reads names, issuer and validity', async () => {
        const { adapter, calls } = source(() => new Response(FIXTURE));
        const page = await adapter.read(DOMAIN, null, signal);
        expect(calls.map((call) => call.url)).toEqual([
            'https://crt.sh/?q=%25.engines.ptbk.test&output=json&exclude=expired',
        ]);
        expect(calls[0]?.init.redirect).toBe('error');
        expect(calls[0]?.init.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'test-agent' });
        expect(page.cursor).toBe('15000001005');
        expect(page.issuances).toHaveLength(5);
        expect(page.issuances[0]).toEqual({
            hostnames: ['k3v6xq2mfz4pd7h5wn2rbtcayu.engines.ptbk.test'],
            issuer: "C=US, O=Let's Encrypt, CN=R11",
            notBefore: Date.UTC(2026, 9, 20, 7),
        });
        expect(page.issuances.map((issuance) => issuance.hostnames[0])).toContain('*.engines.ptbk.test');
    });

    it('skips what the cursor already covers and keeps the cursor when nothing is new', async () => {
        const { adapter } = source(() => new Response(FIXTURE));
        const page = await adapter.read(DOMAIN, '15000001003', signal);
        expect(page.issuances.map((issuance) => issuance.hostnames)).toEqual([
            ['abcdefghijklmnopqrstuvwxyz.engines.ptbk.test'],
            ['login.engines.ptbk.test'],
        ]);
        expect(await adapter.read(DOMAIN, '15000001005', signal)).toEqual({ issuances: [], cursor: '15000001005' });
        expect(await source(() => new Response('[]')).adapter.read(DOMAIN, null, signal)).toEqual({
            issuances: [],
            cursor: null,
        });
    });

    it('merges the common name into the names, lower-cased, once each, and honours an explicit zone', async () => {
        const entry = {
            id: 1,
            issuer_name: 'CN=x',
            common_name: 'A.Engines.Ptbk.Test',
            name_value: 'a.engines.ptbk.test\nB.engines.ptbk.test\n',
            not_before: '2026-10-20T07:00:00+02:00',
        };
        const { adapter } = source(() => Response.json([entry, { ...entry, id: 2, common_name: null }]));
        const page = await adapter.read(DOMAIN, null, signal);
        expect(page.issuances.map((issuance) => issuance.hostnames)).toEqual([
            ['a.engines.ptbk.test', 'b.engines.ptbk.test'],
            ['a.engines.ptbk.test', 'b.engines.ptbk.test'],
        ]);
        expect(page.issuances[0]?.notBefore).toBe(Date.UTC(2026, 9, 20, 5));
    });

    it.each([
        ['an error status', () => new Response('busy', { status: 503 })],
        ['an unexpected shape', () => Response.json([{ id: 'x' }])],
        [
            'an invalid timestamp',
            () => Response.json([{ id: 1, issuer_name: 'x', name_value: 'a', not_before: 'soon' }]),
        ],
        ['too large an answer', () => new Response(new Uint8Array(16 * 1024 * 1024 + 1))],
    ])('fails on %s', async (_, answer) => {
        await expect(source(answer).adapter.read(DOMAIN, null, signal)).rejects.toMatchObject({
            name: 'CtSourceError',
        });
    });
});
