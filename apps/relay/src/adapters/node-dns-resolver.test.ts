import { Hostname } from '@ptbk/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FakeDnsServer } from '../testing/fake-dns-server';
import { startFakeDnsServer } from '../testing/fake-dns-server';
import { createInMemoryDnsResolver } from './in-memory-dns-resolver';
import { createNodeDnsResolver } from './node-dns-resolver';

const hostname = Hostname.parse('agents.customer.test');
const target = Hostname.parse('abcdefghijklmnopqrstuvwxyz.engine.test');
const live = (): AbortSignal => new AbortController().signal;

describe('node DNS resolver', () => {
    let server: FakeDnsServer;

    beforeEach(async () => {
        server = await startFakeDnsServer();
    });

    afterEach(async () => {
        await server.close();
    });

    const resolver = (timeoutMs = 500) => createNodeDnsResolver({ servers: [server.address], timeoutMs });

    it('lowercases the target and drops the trailing dot', async () => {
        server.answer(hostname, { kind: 'cname', targets: ['ABCDEFGHIJKLMNOPQRSTUVWXYZ.Engine.Test.'] });
        await expect(resolver().resolveCname(hostname, live())).resolves.toEqual({ kind: 'cname', target });
    });

    // Several CNAMEs at one name are invalid DNS (RFC 2181 §10.1); c-ares reports only the first, so the adapter's
    // "several records" branch never sees them. This pins that behaviour so a c-ares change is noticed.
    it('gets only the first of several CNAME records from c-ares', async () => {
        server.answer(hostname, { kind: 'cname', targets: [target, 'other.engine.test'] });
        await expect(resolver().resolveCname(hostname, live())).resolves.toEqual({ kind: 'cname', target });
    });

    it.each([
        ['an IP-looking target', '1.2.3.4'],
        ['a label with an underscore', '_acme.engine.test'],
    ])('treats %s as none', async (_, invalid) => {
        server.answer(hostname, { kind: 'cname', targets: [invalid] });
        await expect(resolver().resolveCname(hostname, live())).resolves.toEqual({ kind: 'none' });
    });

    it.each([
        ['NODATA', { kind: 'nodata' }],
        ['NXDOMAIN', { kind: 'nxdomain' }],
    ] as const)('maps %s to none', async (_, reply) => {
        server.answer(hostname, reply);
        await expect(resolver().resolveCname(hostname, live())).resolves.toEqual({ kind: 'none' });
    });

    it('maps SERVFAIL to error', async () => {
        server.answer(hostname, { kind: 'servfail' });
        await expect(resolver().resolveCname(hostname, live())).resolves.toEqual({ kind: 'error' });
    });

    it('maps a server that never answers to error after the timeout', async () => {
        server.answer(hostname, { kind: 'silent' });
        await expect(resolver(200).resolveCname(hostname, live())).resolves.toEqual({ kind: 'error' });
        expect(server.queries()).toBeGreaterThanOrEqual(1);
    });

    it('rejects with the abort reason when aborted mid-query', async () => {
        server.answer(hostname, { kind: 'silent' });
        const controller = new AbortController();
        const reason = new Error('caller gave up');
        const pending = resolver(5000).resolveCname(hostname, controller.signal);
        await waitFor(() => server.queries() > 0);
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
    });

    it('sends no query for an already aborted signal, with system resolvers too', async () => {
        const reason = new Error('caller gave up');
        const system = createNodeDnsResolver({ servers: null, timeoutMs: 500 });
        await expect(system.resolveCname(hostname, AbortSignal.abort(reason))).rejects.toBe(reason);
        await expect(resolver().resolveCname(hostname, AbortSignal.abort(reason))).rejects.toBe(reason);
        expect(server.queries()).toBe(0);
    });
});

describe('in-memory DNS resolver', () => {
    it('answers none by default and counts queries per hostname', async () => {
        const resolver = createInMemoryDnsResolver();
        await expect(resolver.resolveCname(hostname, live())).resolves.toEqual({ kind: 'none' });
        await resolver.resolveCname(hostname, live());
        await resolver.resolveCname(target, live());
        expect(resolver.queries(hostname)).toBe(2);
        expect(resolver.queries(target)).toBe(1);
        expect(resolver.queries(Hostname.parse('never.asked.test'))).toBe(0);
        expect(resolver.totalQueries()).toBe(3);
    });

    it('rejects for a throw answer', async () => {
        const resolver = createInMemoryDnsResolver();
        resolver.setAnswer(hostname, { kind: 'throw' });
        await expect(resolver.resolveCname(hostname, live())).rejects.toThrow('resolver failure');
    });

    it('hangs until the signal aborts, then rejects with its reason', async () => {
        const resolver = createInMemoryDnsResolver();
        resolver.setAnswer(hostname, { kind: 'hang' });
        const controller = new AbortController();
        const reason = new Error('timed out');
        const pending = resolver.resolveCname(hostname, controller.signal);
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
    });
});

/** Polls an I/O condition on real time: the query crosses a socket, so there is no event to await. */
async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    expect(condition()).toBe(true);
}
