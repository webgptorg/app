import { Hostname } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TestDeps } from '../testing/test-deps';
import { createTestDeps } from '../testing/test-deps';
import { createCachedDnsResolver } from './cached-dns';
import type { DnsResolver } from './dns-resolver';

const SECOND = 1000;
const TTL_MS = 300 * SECOND;
const MAX_STALE_MS = 86_400 * SECOND;
const TIMEOUT_MS = 3 * SECOND;

const signal = new AbortController().signal;
const custom = Hostname.parse('agents.customer.test');
const target = Hostname.parse('aaaaaaaaaaaaaaaaaaaaaaaaaa.engine.test');
const otherTarget = Hostname.parse('bbbbbbbbbbbbbbbbbbbbbbbbbb.engine.test');
const cname = { kind: 'cname', target } as const;

describe('cached DNS resolver', () => {
    let clock: TestDeps['clock'];
    let inner: TestDeps['dns'];
    let logger: TestDeps['logger'];
    let dns: DnsResolver;

    beforeEach(() => {
        ({ clock, dns: inner, logger } = createTestDeps());
        inner.setAnswer(custom, cname);
        dns = createCachedDnsResolver({
            inner,
            clock,
            logger,
            ttlMs: TTL_MS,
            maxStaleMs: MAX_STALE_MS,
            timeoutMs: TIMEOUT_MS,
        });
    });

    it('serves a hit within 5 minutes without a query', async () => {
        await expect(dns.resolveCname(custom, signal)).resolves.toEqual(cname);
        clock.advance(TTL_MS - 1);
        await expect(dns.resolveCname(custom, signal)).resolves.toEqual(cname);
        expect(inner.queries(custom)).toBe(1);
    });

    it('caches none like any other definite answer', async () => {
        inner.setAnswer(custom, { kind: 'none' });
        await dns.resolveCname(custom, signal);
        await expect(dns.resolveCname(custom, signal)).resolves.toEqual({ kind: 'none' });
        expect(inner.queries(custom)).toBe(1);
    });

    it('re-queries once the TTL has passed', async () => {
        await dns.resolveCname(custom, signal);
        clock.advance(TTL_MS);
        await dns.resolveCname(custom, signal);
        expect(inner.queries(custom)).toBe(2);
    });

    it.each([
        ['an error answer', { kind: 'error' } as const, 'error'],
        ['a thrown error', { kind: 'throw' } as const, 'threw'],
    ])(
        'keeps the last positive result through %s for up to 24 hours, then answers error',
        async (_, failure, reason) => {
            await dns.resolveCname(custom, signal);
            inner.setAnswer(custom, failure);
            clock.advance(MAX_STALE_MS - 1);
            await expect(dns.resolveCname(custom, signal)).resolves.toEqual(cname);
            expect(logger.entries).toEqual([
                {
                    level: 'warn',
                    event: 'dns.stale',
                    fields: { reason, ageS: Math.floor((MAX_STALE_MS - 1) / SECOND) },
                },
            ]);
            clock.advance(1);
            await expect(dns.resolveCname(custom, signal)).resolves.toEqual({ kind: 'error' });
        },
    );

    it('treats a timeout as an error and aborts the query', async () => {
        await dns.resolveCname(custom, signal);
        clock.advance(TTL_MS);
        inner.setAnswer(custom, { kind: 'hang' });
        const pending = dns.resolveCname(custom, signal);
        await Promise.resolve();
        clock.advance(TIMEOUT_MS);
        await expect(pending).resolves.toEqual(cname);
        expect(logger.entries[0]?.fields).toMatchObject({ reason: 'timeout' });
        expect(clock.pendingTimers()).toBe(0);
    });

    it('answers error when the resolver fails and nothing positive was seen', async () => {
        inner.setAnswer(custom, { kind: 'error' });
        await expect(dns.resolveCname(custom, signal)).resolves.toEqual({ kind: 'error' });
        inner.setAnswer(custom, { kind: 'none' });
        clock.advance(TTL_MS);
        await dns.resolveCname(custom, signal);
        inner.setAnswer(custom, { kind: 'error' });
        clock.advance(TTL_MS);
        await expect(dns.resolveCname(custom, signal)).resolves.toEqual({ kind: 'error' });
        expect(logger.entries).toEqual([]);
    });

    it.each([
        ['a fresh none', { kind: 'none' } as const],
        ['a changed target', { kind: 'cname', target: otherTarget } as const],
    ])('replaces a cached positive result with %s at once, never falling back to it', async (_, answer) => {
        await dns.resolveCname(custom, signal);
        inner.setAnswer(custom, answer);
        clock.advance(TTL_MS);
        await expect(dns.resolveCname(custom, signal)).resolves.toEqual(answer);
        inner.setAnswer(custom, { kind: 'error' });
        clock.advance(TTL_MS);
        await expect(dns.resolveCname(custom, signal)).resolves.toEqual(
            answer.kind === 'cname' ? answer : { kind: 'error' },
        );
    });

    it('shares one query among concurrent lookups', async () => {
        const lookups = Array.from({ length: 10 }, () => dns.resolveCname(custom, signal));
        await expect(Promise.all(lookups)).resolves.toEqual(Array.from({ length: 10 }, () => cname));
        expect(inner.queries(custom)).toBe(1);
    });

    it('stops waiting when the signal aborts', async () => {
        inner.setAnswer(custom, { kind: 'hang' });
        const reason = new Error('revalidation cancelled');
        const controller = new AbortController();
        const pending = dns.resolveCname(custom, controller.signal);
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
        await expect(dns.resolveCname(custom, AbortSignal.abort(reason))).rejects.toBe(reason);
        expect(inner.queries(custom)).toBe(1);
    });
});
