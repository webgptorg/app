import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RelayNode } from '../stack.ts';
import { RELAYS, RELAY_DNS } from '../stack.ts';
import { ZONE_FILES, nextSerial, renderEngineZone, renderOrderZone, zoneFileWriter } from './zones.ts';

const [RELAY_A, RELAY_B] = RELAYS as readonly [RelayNode, RelayNode];
const STATIC_ZONES = join(import.meta.dirname, '..', '..', 'coredns', 'zones');

function aRecords(zone: string): readonly string[] {
    return zone.split('\n').filter((line) => line.includes(' IN A '));
}

describe('the relay DNS zones', () => {
    it('answer every engine name with the listed relays only', () => {
        expect(aRecords(renderEngineZone([RELAY_B], 7, 5))).toEqual([`* 5 IN A ${RELAY_B.ip}`]);
        expect(renderEngineZone([RELAY_B], 7, 5)).toContain('engine.test. 7 60 60 60 5');
    });

    it('list the named relay first and drop it once it has left', () => {
        expect(aRecords(renderOrderZone(RELAYS, RELAYS, 1, 5))).toEqual([
            `relay-a-first 5 IN A ${RELAY_A.ip}`,
            `relay-a-first 5 IN A ${RELAY_B.ip}`,
            `relay-b-first 5 IN A ${RELAY_B.ip}`,
            `relay-b-first 5 IN A ${RELAY_A.ip}`,
        ]);
        expect(aRecords(renderOrderZone(RELAYS, [RELAY_B], 2, 5))).toEqual([
            `relay-a-first 5 IN A ${RELAY_B.ip}`,
            `relay-b-first 5 IN A ${RELAY_B.ip}`,
        ]);
    });

    it('are what the base stack serves when every relay is listed (coredns/zones/)', async () => {
        expect(await readFile(join(STATIC_ZONES, ZONE_FILES.engine), 'utf8')).toBe(
            renderEngineZone(RELAYS, 1, RELAY_DNS.ttlS),
        );
        expect(await readFile(join(STATIC_ZONES, ZONE_FILES.order), 'utf8')).toBe(
            renderOrderZone(RELAYS, RELAYS, 1, RELAY_DNS.ttlS),
        );
    });

    it('grow the serial on every write, even twice within a second', () => {
        expect(nextSerial(1, 1_761_213_600_500)).toBe(1_761_213_600);
        expect(nextSerial(1_761_213_600, 1_761_213_600_900)).toBe(1_761_213_601);
    });
});

describe('the zone file writer', () => {
    let dir: string | undefined;
    afterEach(async () => {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    });

    it('replaces both zones with a higher serial and leaves no temporary file', async () => {
        dir = await mkdtemp(join(tmpdir(), 'relay-dns-'));
        const write = zoneFileWriter(dir, RELAYS, 5, () => 1_761_213_600_000);
        await write(RELAYS);
        await write([RELAY_B]);
        expect(await readdir(dir)).toEqual([ZONE_FILES.engine, ZONE_FILES.order].sort());
        expect(await readFile(join(dir, ZONE_FILES.engine), 'utf8')).toBe(
            renderEngineZone([RELAY_B], 1_761_213_601, 5),
        );
        expect(await readFile(join(dir, ZONE_FILES.order), 'utf8')).toBe(
            renderOrderZone(RELAYS, [RELAY_B], 1_761_213_601, 5),
        );
    });
});
