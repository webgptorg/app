/*
 * The stand-in's loop: check every relay, apply the health rule (health.ts), publish the listed relays when they change
 * and raise an alert on every health change. The DNS side sits behind `RelayDnsWriter`, the seam a checker that edits
 * records through the Cloudflare API would plug into if the load balancer ever has to be replaced (I-07, Risks).
 */
import type { ProbeTarget } from '../probe.ts';
import type { RelayNode } from '../stack.ts';
import type { HealthChange, HealthThresholds } from './health.ts';
import { createRelayHealth } from './health.ts';

export type RelayDnsWriter = (listed: readonly RelayNode[]) => Promise<void>;

/** Resolves true when the relay passed: it must never reject. */
export type RelayCheck = (relay: RelayNode) => Promise<boolean>;

/** One JSON log line per change, in the shape src/service-events.ts reads. Only relays' own hostnames appear. */
export interface RelayDnsAlert {
    readonly time: string;
    readonly level: 'alert';
    readonly event: 'relay_dns.relay_left' | 'relay_dns.relay_rejoined' | 'relay_dns.all_unhealthy';
    readonly relay: string;
    readonly listed: readonly string[];
}

export function alertFor(change: HealthChange<RelayNode>, nowMs: number): RelayDnsAlert {
    const event = change.fallback
        ? 'relay_dns.all_unhealthy'
        : change.healthy
          ? 'relay_dns.relay_rejoined'
          : 'relay_dns.relay_left';
    return {
        time: new Date(nowMs).toISOString(),
        level: 'alert',
        event,
        relay: change.relay.hostname,
        listed: change.listed.map((relay) => relay.hostname),
    };
}

export interface RelayDnsCheckerOptions {
    readonly relays: readonly RelayNode[];
    readonly thresholds: HealthThresholds;
    readonly check: RelayCheck;
    readonly writer: RelayDnsWriter;
    readonly alert: (alert: RelayDnsAlert) => void;
    readonly now?: () => number;
}

export interface RelayDnsChecker {
    /** Publishes every relay, before the first check. */
    start(): Promise<void>;
    /** One round: every relay checked in parallel, then the DNS updated if the listed relays changed. */
    tick(): Promise<void>;
}

export function createRelayDnsChecker(options: RelayDnsCheckerOptions): RelayDnsChecker {
    const now = options.now ?? Date.now;
    const health = createRelayHealth(options.relays, options.thresholds);
    let published: readonly RelayNode[] = [];

    const publish = async (listed: readonly RelayNode[]): Promise<void> => {
        await options.writer(listed);
        published = listed;
    };

    return {
        start: () => publish(health.listed()),
        async tick() {
            const passed = await Promise.all(options.relays.map((relay) => options.check(relay)));
            options.relays.forEach((relay, index) => {
                const change = health.record(relay, passed[index] === true);
                if (change !== null) options.alert(alertFor(change, now()));
            });
            const listed = health.listed();
            if (listed.length !== published.length || listed.some((relay, index) => relay !== published[index])) {
                await publish(listed);
            }
        },
    };
}

/**
 * What Cloudflare's HTTPS monitor does: GET /healthz on the relay's own hostname, certificate verified, 200 expected,
 * all within `timeoutMs`. A relay that accepts TCP and then stalls in TLS fails by the deadline.
 */
export function healthzCheck(
    probe: (target: ProbeTarget) => Promise<number>,
    ca: string,
    port: number,
    timeoutMs: number,
): RelayCheck {
    return async (relay) => {
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<boolean>((resolve) => {
            timer = setTimeout(() => {
                resolve(false);
            }, timeoutMs);
        });
        const status = probe({ address: relay.ip, port, servername: relay.hostname, path: '/healthz', ca, timeoutMs })
            .then((code) => code === 200)
            .catch(() => false);
        try {
            return await Promise.race([status, deadline]);
        } finally {
            clearTimeout(timer);
        }
    };
}
