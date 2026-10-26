import { describe, expect, it } from 'vitest';

import { MAX_DATABASE_ENTRIES, createWebRiskApi, decodeBase64 } from './web-risk-api';

const API_KEY = `AIza${'k'.repeat(35)}`;
const NOW = Date.UTC(2026, 9, 26, 12);
const signal = new AbortController().signal;
const b64 = (bytes: readonly number[]) => Buffer.from(bytes).toString('base64');
const CHECKSUM = b64(new Array<number>(32).fill(7));
const HASH = new Array<number>(32).fill(9);

function api(answer: () => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createWebRiskApi({
        apiKey: API_KEY,
        userAgent: 'test-agent',
        nowMs: () => NOW,
        fetch: (url, init) => {
            calls.push({ url, init });
            return Promise.resolve(answer());
        },
    });
    return { client, calls };
}

const diff = (body: Record<string, unknown>) => () =>
    Response.json({ responseType: 'DIFF', newVersionToken: 'AQI=', checksum: { sha256: CHECKSUM }, ...body });

describe('createWebRiskApi computeDiff', () => {
    it('asks for one RAW list with its version token and the key in a header', async () => {
        const { client, calls } = api(diff({}));
        await client.computeDiff('MALWARE', 'Gg4IBBADIgYQgBAiAQEoAQ==', signal);
        const url = new URL(calls[0]?.url ?? '');
        expect(`${url.origin}${url.pathname}`).toBe('https://webrisk.googleapis.com/v1/threatLists:computeDiff');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            threatType: 'MALWARE',
            'constraints.maxDatabaseEntries': String(MAX_DATABASE_ENTRIES),
            'constraints.supportedCompressions': 'RAW',
            versionToken: 'Gg4IBBADIgYQgBAiAQEoAQ==',
        });
        expect(calls[0]?.init).toMatchObject({
            redirect: 'error',
            headers: { Accept: 'application/json', 'User-Agent': 'test-agent', 'X-Goog-Api-Key': API_KEY },
        });
        await client.computeDiff('MALWARE', null, signal);
        expect(new URL(calls[1]?.url ?? '').searchParams.has('versionToken')).toBe(false);
    });

    it('decodes additions and removals, drops unknown fields and reads nanosecond times', async () => {
        const { client } = api(
            diff({
                additions: {
                    rawHashes: [
                        { prefixSize: 4, rawHashes: b64([1, 2, 3, 4, 5, 6, 7, 8]) },
                        { prefixSize: 5, rawHashes: '-_-_-_8', future: true },
                    ],
                },
                removals: { rawIndices: { indices: [0, 3] } },
                recommendedNextDiff: '2026-10-26T12:30:00.123456789Z',
                someNewField: { nested: 1 },
            }),
        );
        expect(await client.computeDiff('SOCIAL_ENGINEERING', 'AQI=', signal)).toEqual({
            kind: 'diff',
            additions: [
                { prefixSize: 4, hashes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) },
                { prefixSize: 5, hashes: Uint8Array.from([0xfb, 0xff, 0xbf, 0xfb, 0xff]) },
            ],
            removals: [0, 3],
            checksum: Uint8Array.from(new Array<number>(32).fill(7)),
            versionToken: 'AQI=',
            nextDiffAt: Date.UTC(2026, 9, 26, 12, 30, 0, 123),
        });
    });

    it('reads a reset, and diffs at once when Google recommends no time', async () => {
        const { client } = api(diff({ responseType: 'RESET' }));
        expect(await client.computeDiff('UNWANTED_SOFTWARE', null, signal)).toMatchObject({
            kind: 'reset',
            additions: [],
            removals: [],
            nextDiffAt: NOW,
        });
    });

    it.each<[string, () => Response]>([
        ['a quota', () => Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { status: 429 })],
        ['a denied key', () => new Response(`API key ${API_KEY} not valid`, { status: 403 })],
        ['something other than JSON', () => new Response('<html>')],
        ['too large an answer', () => new Response(new Uint8Array(32 * 1024 * 1024 + 1))],
        ['an unspecified response type', diff({ responseType: 'RESPONSE_TYPE_UNSPECIFIED' })],
        ['no version token', diff({ newVersionToken: '' })],
        ['Rice-encoded additions', diff({ additions: { riceHashes: { firstValue: '1' } } })],
        ['Rice-encoded removals', diff({ removals: { riceIndices: { firstValue: '1' } } })],
        ['a prefix size out of range', diff({ additions: { rawHashes: [{ prefixSize: 3, rawHashes: 'AQID' }] } })],
        ['a negative removal', diff({ removals: { rawIndices: { indices: [-1] } } })],
        ['removals with a reset', diff({ responseType: 'RESET', removals: { rawIndices: { indices: [0] } } })],
        ['a short checksum', diff({ checksum: { sha256: b64([1, 2, 3]) } })],
        ['a version token that is not base64', diff({ newVersionToken: 'not base64!' })],
        ['hashes that are not base64', diff({ additions: { rawHashes: [{ prefixSize: 4, rawHashes: 'AQ*D' }] } })],
        ['an invalid time', diff({ recommendedNextDiff: 'tomorrow' })],
    ])('fails on %s, without echoing the key', async (_, answer) => {
        const error: unknown = await api(answer)
            .client.computeDiff('MALWARE', null, signal)
            .catch((caught: unknown) => caught);
        expect(error).toMatchObject({ name: 'WebRiskError' });
        expect(String(error)).not.toContain(API_KEY);
    });
});

describe('createWebRiskApi searchHashes', () => {
    it('asks for one prefix in standard base64 under every threat type, and reads the threats and the negative time', async () => {
        const { client, calls } = api(() =>
            Response.json({
                threats: [
                    {
                        threatTypes: ['MALWARE', 'A_FUTURE_TYPE'],
                        hash: b64(HASH),
                        expireTime: '2026-10-26T12:05:00Z',
                        extra: 1,
                    },
                ],
                negativeExpireTime: '2026-10-26T13:00:00Z',
            }),
        );
        expect(
            await client.searchHashes(
                Uint8Array.from([0xfb, 0xff, 0xbf, 0xff]),
                ['MALWARE', 'SOCIAL_ENGINEERING'],
                signal,
            ),
        ).toEqual({
            threats: [{ hash: Uint8Array.from(HASH), until: Date.UTC(2026, 9, 26, 12, 5) }],
            negativeUntil: Date.UTC(2026, 9, 26, 13),
        });
        const url = new URL(calls[0]?.url ?? '');
        expect(url.pathname).toBe('/v1/hashes:search');
        expect(url.searchParams.get('hashPrefix')).toBe('+/+//w==');
        expect(url.searchParams.getAll('threatTypes')).toEqual(['MALWARE', 'SOCIAL_ENGINEERING']);
        expect(url.toString()).not.toContain(API_KEY);
    });

    it('reads an answer without threats or times as clean, cached for no time', async () => {
        expect(
            await api(() => Response.json({})).client.searchHashes(Uint8Array.from([1, 2, 3, 4]), ['MALWARE'], signal),
        ).toEqual({
            threats: [],
            negativeUntil: NOW,
        });
    });

    it.each<[string, () => Response]>([
        ['a server error', () => new Response('', { status: 500 })],
        [
            'a threat without types',
            () =>
                Response.json({ threats: [{ threatTypes: [], hash: b64(HASH), expireTime: '2026-10-26T12:05:00Z' }] }),
        ],
        [
            'a hash that is not 32 bytes',
            () =>
                Response.json({
                    threats: [
                        { threatTypes: ['MALWARE'], hash: b64([1, 2, 3, 4]), expireTime: '2026-10-26T12:05:00Z' },
                    ],
                }),
        ],
        ['threats that are not a list', () => Response.json({ threats: {} })],
        ['too large an answer', () => new Response(new Uint8Array(1024 * 1024 + 1))],
    ])('fails on %s', async (_, answer) => {
        await expect(
            api(answer).client.searchHashes(Uint8Array.from([1, 2, 3, 4]), ['MALWARE'], signal),
        ).rejects.toMatchObject({
            name: 'WebRiskError',
        });
    });
});

describe('decodeBase64', () => {
    it('reads both alphabets, with or without padding, and refuses the rest', () => {
        expect(decodeBase64('+/+/')).toEqual(Uint8Array.from([0xfb, 0xff, 0xbf]));
        expect(decodeBase64('-_-_')).toEqual(Uint8Array.from([0xfb, 0xff, 0xbf]));
        expect(decodeBase64('AQ')).toEqual(Uint8Array.from([1]));
        expect(decodeBase64('')).toEqual(new Uint8Array());
        expect(decodeBase64('A')).toBeNull();
        expect(decodeBase64('A B=')).toBeNull();
    });
});
