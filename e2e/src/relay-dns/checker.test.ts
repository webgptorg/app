import { describe, expect, it } from 'vitest';

import type { ProbeTarget } from '../probe.ts';
import type { RelayNode } from '../stack.ts';
import { RELAYS } from '../stack.ts';
import type { RelayDnsAlert } from './checker.ts';
import { createRelayDnsChecker, healthzCheck } from './checker.ts';

const [RELAY_A, RELAY_B] = RELAYS as readonly [RelayNode, RelayNode];
const NOW = Date.parse('2026-10-23T10:00:00.000Z');

function harness(thresholds = { consecutiveDown: 2, consecutiveUp: 2 }) {
    const up = new Map<RelayNode, boolean>(RELAYS.map((relay) => [relay, true]));
    const published: (readonly string[])[] = [];
    const alerts: RelayDnsAlert[] = [];
    const checker = createRelayDnsChecker({
        relays: RELAYS,
        thresholds,
        check: (relay) => Promise.resolve(up.get(relay) === true),
        writer: (listed) => {
            published.push(listed.map((relay) => relay.service));
            return Promise.resolve();
        },
        alert: (alert) => alerts.push(alert),
        now: () => NOW,
    });
    const ticks = async (count: number): Promise<void> => {
        for (let i = 0; i < count; i++) await checker.tick();
    };
    return { up, published, alerts, checker, ticks };
}

describe('the relay DNS checker', () => {
    it('publishes every relay at start and nothing more while they pass', async () => {
        const { published, alerts, checker, ticks } = harness();
        await checker.start();
        await ticks(5);
        expect(published).toEqual([['relay-a', 'relay-b']]);
        expect(alerts).toEqual([]);
    });

    it('takes a failing relay out after the threshold, alerts, and puts it back once it recovers', async () => {
        const { up, published, alerts, checker, ticks } = harness();
        await checker.start();
        up.set(RELAY_A, false);
        await ticks(1);
        expect(published).toHaveLength(1);
        await ticks(1);
        expect(published.at(-1)).toEqual(['relay-b']);
        expect(alerts).toEqual([
            {
                time: '2026-10-23T10:00:00.000Z',
                level: 'alert',
                event: 'relay_dns.relay_left',
                relay: RELAY_A.hostname,
                listed: [RELAY_B.hostname],
            },
        ]);

        up.set(RELAY_A, true);
        await ticks(2);
        expect(published.at(-1)).toEqual(['relay-a', 'relay-b']);
        expect(alerts.at(-1)).toMatchObject({ event: 'relay_dns.relay_rejoined', relay: RELAY_A.hostname });
        expect(published).toHaveLength(3);
    });

    it('keeps every relay listed and alerts when all of them fail', async () => {
        const { up, published, alerts, checker, ticks } = harness();
        await checker.start();
        up.set(RELAY_A, false);
        up.set(RELAY_B, false);
        await ticks(4);
        expect(published.at(-1)).toEqual(['relay-a', 'relay-b']);
        expect(alerts.map((alert) => alert.event)).toEqual(['relay_dns.relay_left', 'relay_dns.all_unhealthy']);
        expect(alerts.at(-1)?.listed).toEqual([RELAY_A.hostname, RELAY_B.hostname]);
    });

    it('logs no address and no name but the relays’ own hostnames', async () => {
        const { up, alerts, checker, ticks } = harness({ consecutiveDown: 1, consecutiveUp: 1 });
        await checker.start();
        up.set(RELAY_B, false);
        await ticks(1);
        const text = JSON.stringify(alerts);
        for (const relay of RELAYS) expect(text).not.toContain(relay.ip);
        expect(text).not.toContain('engine.test');
    });
});

describe('the healthz check', () => {
    const target = (calls: ProbeTarget[], answer: () => Promise<number>) => (probeTarget: ProbeTarget) => {
        calls.push(probeTarget);
        return answer();
    };

    it('asks the relay’s own hostname for /healthz on its address and passes on 200', async () => {
        const calls: ProbeTarget[] = [];
        const check = healthzCheck(
            target(calls, () => Promise.resolve(200)),
            'CA',
            443,
            1_000,
        );
        expect(await check(RELAY_A)).toBe(true);
        expect(calls).toEqual([
            {
                address: RELAY_A.ip,
                port: 443,
                servername: RELAY_A.hostname,
                path: '/healthz',
                ca: 'CA',
                timeoutMs: 1_000,
            },
        ]);
    });

    it('fails on another status and on any error', async () => {
        expect(
            await healthzCheck(
                target([], () => Promise.resolve(503)),
                'CA',
                443,
                1_000,
            )(RELAY_A),
        ).toBe(false);
        const refused = () => Promise.reject(new Error('ECONNREFUSED'));
        expect(await healthzCheck(target([], refused), 'CA', 443, 1_000)(RELAY_A)).toBe(false);
    });

    it('fails a relay that never answers once the timeout has passed', async () => {
        const hung = () => new Promise<number>(() => undefined);
        const started = Date.now();
        expect(await healthzCheck(target([], hung), 'CA', 443, 50)(RELAY_A)).toBe(false);
        expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    });
});
