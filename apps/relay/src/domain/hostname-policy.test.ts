import type { Hostname, RegistryEntry } from '@ptbk/protocol';
import { Hostname as HostnameSchema, expectedCnameTarget } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TestEngine } from '../testing/engines';
import { ENGINE_DOMAIN, createTestEngine } from '../testing/engines';
import type { TestDeps } from '../testing/test-deps';
import { createTestDeps } from '../testing/test-deps';
import { routableHostnames } from './hostname-policy';

const signal = new AbortController().signal;
const agents = HostnameSchema.parse('agents.customer.test');
const portal = HostnameSchema.parse('portal.customer.test');

describe('routableHostnames', () => {
    let engine: TestEngine;
    let other: TestEngine;
    let dns: TestDeps['dns'];
    let logger: TestDeps['logger'];
    let expected: Hostname;

    beforeEach(async () => {
        engine = await createTestEngine(30, [agents, portal]);
        other = await createTestEngine(31);
        ({ dns, logger } = createTestDeps());
        expected = expectedCnameTarget(engine.engineId, ENGINE_DOMAIN);
    });

    const route = (entry: RegistryEntry = engine.entry) =>
        routableHostnames({ engineId: engine.engineId, entry, engineDomain: ENGINE_DOMAIN, dns, logger, signal });

    it('keeps custom hostnames with a valid claim whose CNAME is the engine default hostname', async () => {
        dns.setAnswer(agents, { kind: 'cname', target: expected });
        dns.setAnswer(portal, { kind: 'cname', target: expected });
        await expect(route()).resolves.toEqual([engine.defaultHostname, agents, portal]);
        expect(logger.entries).toEqual([]);
    });

    it('keeps the default hostname without a DNS query', async () => {
        const onlyDefault = await createTestEngine(32);
        await expect(
            routableHostnames({
                engineId: onlyDefault.engineId,
                entry: onlyDefault.entry,
                engineDomain: ENGINE_DOMAIN,
                dns,
                logger,
                signal,
            }),
        ).resolves.toEqual([onlyDefault.defaultHostname]);
        expect(dns.totalQueries()).toBe(0);
    });

    it('drops a hostname whose claim does not verify, before any DNS query, logging only the count', async () => {
        dns.setAnswer(agents, { kind: 'cname', target: expected });
        dns.setAnswer(portal, { kind: 'cname', target: expected });
        const [stranger] = (await createTestEngine(33, [portal])).entry.claims;
        const forged = {
            ...engine.entry,
            claims: engine.entry.claims.map((claim) => (claim.hostname === portal && stranger ? stranger : claim)),
        };
        await expect(route(forged)).resolves.toEqual([engine.defaultHostname, agents]);
        expect(dns.queries(portal)).toBe(0);
        expect(logger.entries).toEqual([
            { level: 'warn', event: 'hostname.claim-invalid', fields: { engineId: engine.engineId, dropped: 1 } },
        ]);
    });

    it.each([
        ['no CNAME', () => ({ kind: 'none' }) as const],
        [
            'a CNAME to a relay name',
            () => ({ kind: 'cname', target: HostnameSchema.parse('relay-a.ptbk.test') }) as const,
        ],
        [
            "a CNAME to another engine's default hostname",
            () => ({ kind: 'cname', target: other.defaultHostname }) as const,
        ],
        ['a CNAME to the engine domain itself', () => ({ kind: 'cname', target: ENGINE_DOMAIN }) as const],
        ['a DNS error with no earlier positive result', () => ({ kind: 'error' }) as const],
    ])('drops a validly claimed hostname with %s, logging only the engine ID and count', async (_, answer) => {
        dns.setAnswer(agents, { kind: 'cname', target: expected });
        dns.setAnswer(portal, answer());
        const routed = await route();
        expect(routed).toEqual([engine.defaultHostname, agents]);
        expect(logger.entries).toEqual([
            { level: 'warn', event: 'hostname.dns-mismatch', fields: { engineId: engine.engineId, dropped: 1 } },
        ]);
        expect(JSON.stringify(logger.entries)).not.toContain('customer.test');
    });

    it('propagates an abort from the DNS lookup', async () => {
        dns.setAnswer(agents, { kind: 'hang' });
        const controller = new AbortController();
        const pending = routableHostnames({
            engineId: engine.engineId,
            entry: engine.entry,
            engineDomain: ENGINE_DOMAIN,
            dns,
            logger,
            signal: controller.signal,
        });
        const reason = new Error('tunnel closed');
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
    });
});
