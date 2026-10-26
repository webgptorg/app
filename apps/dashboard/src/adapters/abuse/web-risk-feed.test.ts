import { Hostname } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeClock } from '../fake-clock';
import { createMemoryLogger } from '../memory-logger';
import { createFakeWebRiskServer, type FakeWebRiskServer } from '../../testing/fake-web-risk-server';
import { createWebRiskApi } from './web-risk-api';
import { LIST_MAX_OVERDUE_MS, createWebRiskFeed } from './web-risk-feed';
import { expressionHash } from './web-risk-url';
import { createMemoryWebRiskStorage, createWebRiskStore, type WebRiskStore } from './web-risk-store';

const API_KEY = `AIza${'x'.repeat(35)}`;
const MINUTE = 60 * 1000;
const signal = new AbortController().signal;
const listedEngine = Hostname.parse('k3v6xq2mfz4pd7h5wn2rbtcayu.engines.ptbk.test');
const cleanEngine = Hostname.parse('abcdefghijklmnopqrstuvwxyz.engines.ptbk.test');

describe('createWebRiskFeed', () => {
    let clock: ReturnType<typeof createFakeClock>;
    let server: FakeWebRiskServer;
    let store: WebRiskStore;
    let logger: ReturnType<typeof createMemoryLogger>;

    beforeEach(() => {
        clock = createFakeClock(Date.UTC(2026, 9, 26, 12));
        server = createFakeWebRiskServer({ apiKey: API_KEY, nowMs: () => clock.nowMs() });
        store = createWebRiskStore(createMemoryWebRiskStorage());
        logger = createMemoryLogger();
    });

    /** One cron run's feed, as the composition root builds it. */
    const feed = (maxHashSearches?: number) =>
        createWebRiskFeed({
            api: createWebRiskApi({
                fetch: server.fetch,
                apiKey: API_KEY,
                userAgent: 'test',
                nowMs: () => clock.nowMs(),
            }),
            store,
            clock,
            logger,
            ...(maxHashSearches === undefined ? {} : { maxHashSearches }),
        });
    const calls = (method: string) => server.requests.filter((request) => request.method === method).length;

    it('finds a listed engine by its hashes, and confirms the prefix hit with hashes.search', async () => {
        server.list('SOCIAL_ENGINEERING', await expressionHash(`${listedEngine}/`));
        expect(await feed().listed([listedEngine, cleanEngine], signal)).toEqual(new Set([listedEngine]));
        expect(calls('threatLists:computeDiff')).toBe(3);
        expect(calls('hashes:search')).toBe(1);
        const search = server.requests.find((request) => request.method === 'hashes:search');
        expect(new URL(search?.url ?? '').searchParams.getAll('threatTypes')).toEqual([
            'MALWARE',
            'SOCIAL_ENGINEERING',
            'UNWANTED_SOFTWARE',
        ]);
    });

    it('lists every engine when a parent domain is listed, with one hashes.search for the shared prefix', async () => {
        server.list('MALWARE', await expressionHash('engines.ptbk.test/'));
        expect(await feed().listed([listedEngine, cleanEngine], signal)).toEqual(new Set([listedEngine, cleanEngine]));
        expect(calls('hashes:search')).toBe(1);
    });

    it('clears a false-positive prefix hit and asks again only once its negative cache expired', async () => {
        const hash = await expressionHash(`${cleanEngine}/`);
        server.addPrefix('UNWANTED_SOFTWARE', hash.subarray(0, 4));
        expect(await feed().listed([cleanEngine], signal)).toEqual(new Set());
        clock.advance(15 * MINUTE);
        expect(await feed().listed([cleanEngine], signal)).toEqual(new Set());
        expect(calls('hashes:search')).toBe(1);
        clock.advance(46 * MINUTE);
        await feed().listed([cleanEngine], signal);
        expect(calls('hashes:search')).toBe(2);
    });

    it('asks again for a listed hash once its positive cache expired, and notices a delisting', async () => {
        const hash = await expressionHash(`${listedEngine}/`);
        server.list('MALWARE', hash);
        server.addPrefix('MALWARE', hash.subarray(0, 5));
        await feed().listed([listedEngine], signal);
        clock.advance(MINUTE);
        expect(await feed().listed([listedEngine], signal)).toEqual(new Set([listedEngine]));
        expect(calls('hashes:search')).toBe(2);
        clock.advance(5 * MINUTE);
        server.delist(hash);
        expect(await feed().listed([listedEngine], signal)).toEqual(new Set());
        expect(calls('hashes:search')).toBe(4);
    });

    it('asks for a diff only when Google recommends one, from the stored version, and applies removals', async () => {
        const hash = await expressionHash(`${listedEngine}/`);
        server.list('SOCIAL_ENGINEERING', hash);
        await feed().listed([listedEngine], signal);
        clock.advance(15 * MINUTE);
        await feed().listed([listedEngine], signal);
        expect(calls('threatLists:computeDiff')).toBe(3);
        server.delist(hash);
        clock.advance(15 * MINUTE);
        expect(await feed().listed([listedEngine], signal)).toEqual(new Set());
        const diffs = server.requests.filter((request) => request.method === 'threatLists:computeDiff');
        expect(diffs).toHaveLength(6);
        expect(new URL(diffs[0]?.url ?? '').searchParams.has('versionToken')).toBe(false);
        expect(new URL(diffs[3]?.url ?? '').searchParams.get('versionToken')).not.toBeNull();
        // Asked again at 15 minutes (the positive cache had expired), then not at all: the prefix left the local list.
        expect(calls('hashes:search')).toBe(2);
    });

    it('asks every run when Google recommends no time', async () => {
        server.timing.nextDiffMs = null;
        await feed().listed([cleanEngine], signal);
        await feed().listed([cleanEngine], signal);
        expect(calls('threatLists:computeDiff')).toBe(6);
    });

    it('refreshes once per run, however many batches it is asked', async () => {
        server.timing.nextDiffMs = null;
        const run = feed();
        await run.listed([cleanEngine], signal);
        await run.listed([listedEngine], signal);
        expect(calls('threatLists:computeDiff')).toBe(3);
    });

    it('drops a list whose checksum does not match and fails the run, then resets it the next run', async () => {
        server.timing.nextDiffMs = null;
        await feed().listed([cleanEngine], signal);
        server.corruptChecksums = 1;
        await expect(feed().listed([cleanEngine], signal)).rejects.toThrow('the MALWARE list is not available');
        expect(logger.entries).toContainEqual({
            level: 'warn',
            event: 'web-risk.list-mismatch',
            fields: { list: 'MALWARE', kind: 'diff' },
        });
        await feed().listed([cleanEngine], signal);
        const diffs = server.requests.filter((request) => request.method === 'threatLists:computeDiff');
        expect(new URL(diffs[6]?.url ?? '').searchParams.has('versionToken')).toBe(false);
    });

    it('answers from the lists it has while Google is down, until they are overdue', async () => {
        await feed().listed([cleanEngine], signal);
        server.override = () => new Response('unavailable', { status: 503 });
        clock.advance(30 * MINUTE);
        expect(await feed().listed([cleanEngine], signal)).toEqual(new Set());
        expect(logger.entries).toContainEqual({
            level: 'warn',
            event: 'web-risk.diff-failed',
            fields: { list: 'MALWARE', problem: 'WebRiskError' },
        });
        clock.advance(LIST_MAX_OVERDUE_MS + 1);
        await expect(feed().listed([cleanEngine], signal)).rejects.toThrow('not available');
    });

    it("fails without lists or without a prefix hit's answer, so no engine counts as clean on no evidence", async () => {
        server.override = () => new Response('quota', { status: 429 });
        await expect(feed().listed([cleanEngine], signal)).rejects.toMatchObject({ name: 'WebRiskError' });
        expect(logger.entries.filter((entry) => entry.event === 'web-risk.diff-failed')).toHaveLength(3);
        server.timing.nextDiffMs = null;
        server.addPrefix('MALWARE', (await expressionHash(`${cleanEngine}/`)).subarray(0, 4));
        server.override = (method) => (method === 'hashes:search' ? new Response('', { status: 500 }) : null);
        await expect(feed().listed([cleanEngine], signal)).rejects.toThrow('hashes:search answered 500');
    });

    it('stops at the hashes.search budget, keeping the answers it got for the next run', async () => {
        server.timing.nextDiffMs = null;
        const engines = ['b', 'c', 'd'].map((letter) => Hostname.parse(`${letter.repeat(26)}.engines.ptbk.test`));
        for (const engine of engines) {
            server.addPrefix('MALWARE', (await expressionHash(`${engine}/`)).subarray(0, 4));
        }
        await expect(feed(2).listed(engines, signal)).rejects.toThrow('too many prefix hits for one run');
        expect(calls('hashes:search')).toBe(2);
        expect(await feed(2).listed(engines, signal)).toEqual(new Set());
        expect(calls('hashes:search')).toBe(3);
    });

    it('sends the key only in its header, never in a URL, a log or an error', async () => {
        server.override = () => new Response(`denied ${API_KEY}`, { status: 403 });
        const error: unknown = await feed()
            .listed([cleanEngine], signal)
            .catch((caught: unknown) => caught);
        expect(String(error)).not.toContain(API_KEY);
        expect(server.requests.every((request) => !request.url.includes(API_KEY))).toBe(true);
        expect(server.requests.every((request) => request.headers['x-goog-api-key'] === API_KEY)).toBe(true);
        expect(JSON.stringify(logger.entries)).not.toContain(API_KEY);
    });
});
