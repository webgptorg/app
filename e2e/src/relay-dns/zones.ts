/*
 * The zones CoreDNS serves with its `file` plugin (coredns/Corefile): `engine.test`, whose wildcard stands in for the
 * load balancer on `*.<engine domain>`, and `order.ptbk.test`, whose `relay-<x>-first` names list the same relays with
 * one of them first (src/relay-order.ts). coredns/zones/ holds the render with every relay listed, which the base
 * stack serves unchanged; zones.test.ts keeps the two identical. CoreDNS answers an RRset in file order, and Chromium
 * keeps that order for addresses it cannot rank otherwise, which is what makes "listed first" hold.
 */
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RelayNode } from '../stack.ts';
import { ENGINE_DOMAIN, OUR_DOMAIN, relayFirstAlias } from '../stack.ts';

export const ORDER_ZONE = `order.${OUR_DOMAIN}`;

export const ZONE_FILES = {
    engine: `${ENGINE_DOMAIN}.db`,
    order: `${ORDER_ZONE}.db`,
} as const;

function header(origin: string, serial: number, ttlS: number): readonly string[] {
    // CoreDNS's `reload` picks up a file only when this serial grows.
    return [
        `$ORIGIN ${origin}.`,
        `@ ${String(ttlS)} IN SOA ns.${origin}. hostmaster.${origin}. ${String(serial)} 60 60 60 ${String(ttlS)}`,
        `@ ${String(ttlS)} IN NS ns.${origin}.`,
    ];
}

/** No AAAA records: the stack has no IPv6, so browsers never try another family. */
export function renderEngineZone(listed: readonly RelayNode[], serial: number, ttlS: number): string {
    return [
        ...header(ENGINE_DOMAIN, serial, ttlS),
        ...listed.map((relay) => `* ${String(ttlS)} IN A ${relay.ip}`),
        '',
    ].join('\n');
}

/** `relay-<x>-first` lists the listed relays with relay x first, or without it once it has left. */
export function renderOrderZone(
    relays: readonly RelayNode[],
    listed: readonly RelayNode[],
    serial: number,
    ttlS: number,
): string {
    const suffix = `.${ORDER_ZONE}`;
    const records = relays.flatMap((first) => {
        const label = relayFirstAlias(first).slice(0, -suffix.length);
        const ordered = [...listed.filter((relay) => relay === first), ...listed.filter((relay) => relay !== first)];
        return ordered.map((relay) => `${label} ${String(ttlS)} IN A ${relay.ip}`);
    });
    return [...header(ORDER_ZONE, serial, ttlS), ...records, ''].join('\n');
}

/** Unix seconds, so a restarted writer still moves past what CoreDNS loaded; one more when two writes share a second. */
export function nextSerial(previous: number, nowMs: number): number {
    return Math.max(previous + 1, Math.floor(nowMs / 1000));
}

/** Writes both zones into `dir`, each through a rename, so CoreDNS never reads a half-written file. */
export function zoneFileWriter(
    dir: string,
    relays: readonly RelayNode[],
    ttlS: number,
    now: () => number = Date.now,
): (listed: readonly RelayNode[]) => Promise<void> {
    let serial = 1;
    return async (listed) => {
        serial = nextSerial(serial, now());
        const files: readonly (readonly [string, string])[] = [
            [ZONE_FILES.engine, renderEngineZone(listed, serial, ttlS)],
            [ZONE_FILES.order, renderOrderZone(relays, listed, serial, ttlS)],
        ];
        for (const [name, text] of files) {
            const temporary = join(dir, `.${name}.tmp`);
            await writeFile(temporary, text, 'utf8');
            await rename(temporary, join(dir, name));
        }
    };
}
