import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    DNS_IP,
    ENGINE_DOMAIN,
    MOUNTS,
    OUR_DOMAIN,
    PUBLIC_FILES,
    RELAYS,
    SUBNET,
    relayCertificateFile,
} from './stack.ts';

const E2E_DIR = join(import.meta.dirname, '..');
const compose = readFileSync(join(E2E_DIR, 'compose.yaml'), 'utf8');
const corefile = readFileSync(join(E2E_DIR, 'coredns', 'Corefile'), 'utf8');

describe('the topology in compose.yaml and the Corefile', () => {
    it('gives every relay the address and hostname stack.ts names', () => {
        for (const relay of RELAYS) {
            expect(relay.hostname.endsWith(`.${OUR_DOMAIN}`)).toBe(true);
            expect(compose).toContain(`ipv4_address: ${relay.ip}`);
            expect(compose).toContain(`RELAY_HOSTNAME: ${relay.hostname}`);
            expect(compose).toContain(`${MOUNTS.public}/${relayCertificateFile(relay)}`);
            expect(compose).toContain(`${relay.service}-key:${MOUNTS.relayKeys}/${relay.hostname}`);
            expect(corefile).toContain(`${relay.ip} ${relay.hostname}`);
            expect(corefile).toContain(`IN A ${relay.ip}"`);
        }
    });

    it('agrees on the subnet, the resolver and the domains', () => {
        expect(compose).toContain(`subnet: ${SUBNET}`);
        expect(compose).toContain(`ipv4_address: ${DNS_IP}`);
        expect(compose.match(/dns: \[([\d.]+)\]/g)?.every((line) => line === `dns: [${DNS_IP}]`)).toBe(true);
        expect(compose).toContain(`PTBK_ENGINE_DOMAIN: ${ENGINE_DOMAIN}`);
        expect(compose).toContain(`MOCK_DEV_CA_DOMAINS: ${OUR_DOMAIN}`);
        expect(corefile).toContain(`${OUR_DOMAIN}:53 {`);
        expect(corefile).toContain(`${ENGINE_DOMAIN}:53 {`);
        expect(compose).toContain(`${MOUNTS.public}/${PUBLIC_FILES.registry}`);
        expect(compose).toContain(`${MOUNTS.public}/${PUBLIC_FILES.engineIdentity}`);
    });

    it('pins every image it pulls by digest', () => {
        const images = [...compose.matchAll(/^\s+image: (\S+)$/gm)].map((match) => match[1]);
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) expect(image).toMatch(/^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/);
        const dockerfile = readFileSync(join(E2E_DIR, 'docker', 'stack.Dockerfile'), 'utf8');
        const bases = [...dockerfile.matchAll(/^ARG \w+_IMAGE=(\S+)$/gm)].map((match) => match[1]);
        expect(bases).toHaveLength(3);
        for (const image of bases) expect(image).toMatch(/^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/);
    });
});
