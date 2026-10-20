import { Hostname } from '@ptbk/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DnsResolver } from '../domain/dns-resolver';

/** A port-level scenario; each adapter's harness turns it into whatever its backend needs. */
export type DnsScenario =
    { readonly kind: 'cname'; readonly target: Hostname } | { readonly kind: 'none' } | { readonly kind: 'error' };

export interface DnsResolverHarness {
    readonly resolver: DnsResolver;
    given(hostname: Hostname, scenario: DnsScenario): void;
    close(): Promise<void>;
}

/** The `DnsResolver` contract every adapter must meet (engineering.md, adapter tests). */
export function describeDnsResolver(name: string, setup: () => Promise<DnsResolverHarness>): void {
    describe(`DnsResolver contract: ${name}`, () => {
        const hostname = Hostname.parse('agents.customer.test');
        const target = Hostname.parse('abcdefghijklmnopqrstuvwxyz.engine.test');
        let harness: DnsResolverHarness;

        beforeEach(async () => {
            harness = await setup();
        });

        afterEach(async () => {
            await harness.close();
        });

        it('returns the target of exactly one CNAME record', async () => {
            harness.given(hostname, { kind: 'cname', target });
            await expect(harness.resolver.resolveCname(hostname, new AbortController().signal)).resolves.toEqual({
                kind: 'cname',
                target,
            });
        });

        it('returns none when there is no CNAME record', async () => {
            harness.given(hostname, { kind: 'none' });
            await expect(harness.resolver.resolveCname(hostname, new AbortController().signal)).resolves.toEqual({
                kind: 'none',
            });
        });

        it('returns error when the resolver cannot answer', async () => {
            harness.given(hostname, { kind: 'error' });
            await expect(harness.resolver.resolveCname(hostname, new AbortController().signal)).resolves.toEqual({
                kind: 'error',
            });
        });

        it('rejects with the reason of an already aborted signal', async () => {
            harness.given(hostname, { kind: 'cname', target });
            const reason = new Error('caller gave up');
            await expect(harness.resolver.resolveCname(hostname, AbortSignal.abort(reason))).rejects.toBe(reason);
        });
    });
}
