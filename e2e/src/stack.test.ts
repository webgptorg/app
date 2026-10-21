import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    CONNECT_PROXY,
    CONNECT_PROXY_PORT,
    DNS_IP,
    ENGINE_DOMAIN,
    ENGINE_HOST,
    ENGINE_HOST_PORTS,
    ENGINE_LAN_SUBNET,
    GATEWAY,
    RELAY_OTHER_PORT,
    TLS_INSPECTING_PROXY,
    TLS_INSPECTING_PROXY_PORT,
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
const overlay = (name: string): string => readFileSync(join(E2E_DIR, `compose.${name}.yaml`), 'utf8');
const OVERLAYS = ['nat', 'capture', 'egress-443', 'connect-proxy', 'tls-inspecting-proxy', 'debug'] as const;

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

    it('puts the engine LAN, the gateway, the engine host and the proxies where stack.ts says', () => {
        const nat = overlay('nat');
        expect(nat).toContain(`subnet: ${ENGINE_LAN_SUBNET}`);
        expect(nat).toContain(`ENGINE_LAN_SUBNET: ${ENGINE_LAN_SUBNET}`);
        expect(nat).toContain(`GATEWAY_PUBLIC_IP: ${GATEWAY.publicIp}`);
        expect(nat).toContain(`ipv4_address: ${GATEWAY.publicIp}`);
        expect(
            nat.match(new RegExp(`(GATEWAY_LAN_IP: |ipv4_address: )${GATEWAY.lanIp.replaceAll('.', '\\.')}`, 'g')),
        ).toHaveLength(3);
        expect(nat).toContain(`DNS_IP: ${DNS_IP}`);
        expect(nat).toContain(`ipv4_address: ${ENGINE_HOST.ip}`);
        expect(nat).toContain(`ENGINE_HOST_PORTS: ${ENGINE_HOST_PORTS.join(' ')}`);
        expect(overlay('egress-443')).toContain(`'${String(RELAY_OTHER_PORT)}']`);
        for (const [name, proxy, port] of [
            ['connect-proxy', CONNECT_PROXY, CONNECT_PROXY_PORT],
            ['tls-inspecting-proxy', TLS_INSPECTING_PROXY, TLS_INSPECTING_PROXY_PORT],
        ] as const) {
            const text = overlay(name);
            expect(text).toContain(`${proxy.service}:`);
            expect(text).toContain(`ipv4_address: ${proxy.publicIp}`);
            expect(text).toContain(`ipv4_address: ${proxy.lanIp}`);
            expect(text).toContain(`HTTPS_PROXY: http://${proxy.lanIp}:${String(port)}`);
        }
        for (const name of OVERLAYS) {
            expect(
                overlay(name)
                    .match(/dns: \[([\d.]+)\]/g)
                    ?.every((line) => line === `dns: [${DNS_IP}]`) ?? true,
            ).toBe(true);
        }
    });

    it('pins every image it pulls by digest', () => {
        const images = [compose, ...OVERLAYS.map(overlay)].flatMap((text) =>
            [...text.matchAll(/^\s+image: (\S+)$/gm)].map((match) => match[1]),
        );
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) expect(image).toMatch(/^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/);
        const dockerfile = readFileSync(join(E2E_DIR, 'docker', 'stack.Dockerfile'), 'utf8');
        const bases = [...dockerfile.matchAll(/^ARG \w+_IMAGE=(\S+)$/gm)].map((match) => match[1]);
        expect(bases).toHaveLength(3);
        for (const image of bases) expect(image).toMatch(/^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/);
    });

    it('pins every package the images install to an exact version', () => {
        const dockerfile = readFileSync(join(E2E_DIR, 'docker', 'stack.Dockerfile'), 'utf8');
        const packages = [...dockerfile.matchAll(/apt-get install -y --no-install-recommends ([^\\\n]+)/g)].flatMap(
            (match) => match[1]?.trim().split(/\s+/) ?? [],
        );
        expect(packages.length).toBeGreaterThan(0);
        for (const name of packages) expect(name).toMatch(/^[a-z0-9.+-]+=\S+$/);
    });
});
