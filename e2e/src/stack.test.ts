import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { interpolate } from './compose-env.ts';
import { ON_DEMAND_PROFILE } from './scenarios.ts';

import {
    CHALLTESTSRV,
    CONNECT_PROXY,
    CONNECT_PROXY_PORT,
    DASHBOARD,
    DASHBOARD_ORIGIN,
    DASHBOARD_TIMING,
    DNS_IP,
    ENGINE_DOMAIN,
    ENGINE_HOST,
    ENGINE_HOST_PORTS,
    ENGINE_LAN_SUBNET,
    GATEWAY,
    RELAY_DNS,
    RELAY_OTHER_PORT,
    TLS_INSPECTING_PROXY,
    TLS_INSPECTING_PROXY_PORT,
    MOCK_ENGINE_CONTROL,
    MOUNTS,
    OUR_DOMAIN,
    PEBBLE,
    PEBBLE_VALIDITY_S,
    PUBLIC_FILES,
    RELAYS,
    REGISTRY_TOKEN_FILE,
    RELEASE_STORE,
    SERVICE_UID,
    SUBNET,
    UI_RELEASES,
    relayCertificateFile,
} from './stack.ts';

const E2E_DIR = join(import.meta.dirname, '..');
// As e2e runs them: every variable at its default, PTBK_STACK_NET included.
const compose = interpolate(readFileSync(join(E2E_DIR, 'compose.yaml'), 'utf8'));
const corefile = readFileSync(join(E2E_DIR, 'coredns', 'Corefile'), 'utf8');
const overlay = (name: string): string => interpolate(readFileSync(join(E2E_DIR, `compose.${name}.yaml`), 'utf8'));
const dnsServers = (text: string): readonly string[] =>
    [...text.matchAll(/dns: \['?([\d.]+)'?\]/g)].map((match) => match[1] ?? '');
const OVERLAYS = [
    'nat',
    'capture',
    'egress-443',
    'connect-proxy',
    'tls-inspecting-proxy',
    'acme',
    'dashboard',
    'monitoring',
    'relay-dns',
    'debug',
] as const;

describe('the topology in compose.yaml and the Corefile', () => {
    it('gives every relay the address and hostname stack.ts names', () => {
        for (const relay of RELAYS) {
            expect(relay.hostname.endsWith(`.${OUR_DOMAIN}`)).toBe(true);
            expect(compose).toContain(`ipv4_address: ${relay.ip}`);
            expect(compose).toContain(`RELAY_HOSTNAME: ${relay.hostname}`);
            expect(compose).toContain(`${MOUNTS.public}/${relayCertificateFile(relay)}`);
            expect(compose).toContain(`${relay.service}-key:${MOUNTS.relayKeys}/${relay.hostname}`);
            expect(corefile).toContain(`${relay.ip} ${relay.hostname}`);
        }
    });

    it('agrees on the subnet, the resolver and the domains', () => {
        expect(compose).toContain(`subnet: ${SUBNET}`);
        expect(compose).toContain(`ipv4_address: ${DNS_IP}`);
        expect(dnsServers(compose).length).toBeGreaterThan(0);
        expect(dnsServers(compose).every((server) => server === DNS_IP)).toBe(true);
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
            expect(dnsServers(overlay(name)).every((server) => server === DNS_IP)).toBe(true);
        }
    });

    it('serves the engine domain from zone files that the relay-dns stand-in replaces in its overlay', () => {
        for (const zone of [ENGINE_DOMAIN, `order.${OUR_DOMAIN}`]) {
            expect(corefile).toContain(`${zone}:53 {\n    file /etc/coredns/zones/${zone}.db {\n        reload 1s`);
        }
        expect(compose).toContain('- ./coredns/zones:/etc/coredns/zones:ro');
        const relayDns = overlay('relay-dns');
        expect(relayDns).toContain(`  ${RELAY_DNS.service}:\n`);
        expect(relayDns).toContain(`- relay-dns-zones:${RELAY_DNS.zonesMount}\n`);
        expect(relayDns).toContain(`'${RELAY_DNS.zonesMount}/${ENGINE_DOMAIN}.db'`);
        expect(relayDns).toContain('- relay-dns-zones:/etc/coredns/zones:ro');
        const dockerfile = readFileSync(join(E2E_DIR, 'docker', 'stack.Dockerfile'), 'utf8');
        expect(dockerfile).toContain(`RUN install -d -o node -g node ${RELAY_DNS.zonesMount}`);
    });

    it('gives the release store and the mock engine control listener the addresses stack.ts names', () => {
        expect(RELEASE_STORE.hostname.endsWith(`.${OUR_DOMAIN}`)).toBe(true);
        expect(corefile).toContain(`${RELEASE_STORE.ip} ${RELEASE_STORE.hostname}`);
        expect(compose).toContain(`  ${RELEASE_STORE.service}:\n`);
        expect(compose).toContain(`ipv4_address: ${RELEASE_STORE.ip}`);
        expect(compose).toContain(`'${MOUNTS.public}/${PUBLIC_FILES.releaseStoreCertificate}'`);
        expect(compose).toContain(`releases:${MOUNTS.releases}:ro`);
        expect(compose).toContain(`release-store-key:${MOUNTS.releaseStoreKey}:ro`);
        expect(compose).toContain(`PTBK_UI_RELEASE_URL: https://${RELEASE_STORE.hostname}/`);
        expect(compose).toContain(`MOCK_UI_TRUST_POLICY_FILE: ${MOUNTS.public}/${PUBLIC_FILES.uiTrustPolicy}`);
        expect(compose).toContain(`PTBK_PINNED_VERSION: ${UI_RELEASES.installed}`);
        expect(compose).toContain(`ipv4_address: ${MOCK_ENGINE_CONTROL.ip}`);
        expect(compose).toContain(`MOCK_CONTROL_PORT: '${String(MOCK_ENGINE_CONTROL.port)}'`);
        const dockerfile = readFileSync(join(E2E_DIR, 'docker', 'stack.Dockerfile'), 'utf8');
        expect(dockerfile).toContain(`for version in ${UI_RELEASES.installed} ${UI_RELEASES.tampered}; do`);
        expect(dockerfile).toContain(`COPY --from=ui-bundle ${MOUNTS.uiBundles} ${MOUNTS.uiBundles}`);
    });

    it('puts Pebble and its resolver where stack.ts says, validating TLS-ALPN-01 through relay-a', () => {
        const acme = overlay('acme');
        const relayA = RELAYS[0];
        if (relayA === undefined) throw new Error('no relay');
        expect(acme).toContain(`  ${PEBBLE.service}:\n`);
        expect(acme).toContain(`ipv4_address: ${PEBBLE.ip}`);
        expect(acme).toContain(`'${PEBBLE.hostname}:${PEBBLE.ip}'`);
        expect(acme).toContain(`PTBK_ACME_DIRECTORY_URL: https://${PEBBLE.hostname}:${String(PEBBLE.acmePort)}/dir`);
        expect(acme).toContain(`https://${PEBBLE.hostname}:${String(PEBBLE.managementPort)}/roots/0`);
        expect(acme).toContain(`NODE_EXTRA_CA_CERTS: ${MOUNTS.public}/${PUBLIC_FILES.pebbleMinica}`);
        expect(acme).toContain(`  ${CHALLTESTSRV.service}:\n`);
        expect(acme).toContain(`ipv4_address: ${CHALLTESTSRV.ip}`);
        expect(acme).toContain(`'-dnsserver', '${CHALLTESTSRV.ip}:${String(CHALLTESTSRV.dnsPort)}'`);
        expect(acme).toContain(`'-defaultIPv4',\n        '${relayA.ip}',`);
        const config = JSON.parse(readFileSync(join(E2E_DIR, 'pebble', 'pebble-config.json'), 'utf8')) as {
            pebble: { tlsPort: number; profiles: { default: { validityPeriod: number } } };
        };
        expect(config.pebble.tlsPort).toBe(443);
        expect(config.pebble.profiles.default.validityPeriod).toBe(PEBBLE_VALIDITY_S);
        const pebbleImage = /^\s+image: (ghcr\.io\/letsencrypt\/pebble:\S+)$/m.exec(acme)?.[1];
        const dockerfile = readFileSync(join(E2E_DIR, 'docker', 'stack.Dockerfile'), 'utf8');
        expect(dockerfile).toContain(`ARG PEBBLE_IMAGE=${pebbleImage ?? 'missing'}`);
    });

    it('puts the dashboard where stack.ts says, as the only registry, with the timings the tests expect', () => {
        const dashboard = overlay('dashboard');
        expect(DASHBOARD.hostname.endsWith(`.${OUR_DOMAIN}`)).toBe(true);
        expect(DASHBOARD_ORIGIN).toBe(`https://${DASHBOARD.hostname}`);
        expect(corefile).toContain(`${DASHBOARD.ip} ${DASHBOARD.hostname}`);
        expect(dashboard).toContain(`  ${DASHBOARD.service}:\n`);
        expect(dashboard).toContain(`ipv4_address: ${DASHBOARD.ip}`);
        expect(dashboard).toContain(`DASHBOARD_ORIGIN: ${DASHBOARD_ORIGIN}`);
        expect(dashboard).toContain(`DASHBOARD_TLS_CERT: ${MOUNTS.public}/${PUBLIC_FILES.dashboardCertificate}`);
        expect(dashboard).toContain(`DASHBOARD_TLS_KEY: ${MOUNTS.dashboardKey}/key.pem`);
        expect(dashboard).toContain(`dashboard-key:${MOUNTS.dashboardKey}\n`);
        expect(dashboard).toContain(`'--servername',\n          '${DASHBOARD.hostname}',`);
        expect(dashboard).toContain('E2E_REGISTRY: dashboard');
        expect(dashboard).toContain(`"ENGINE_DOMAIN": "${ENGINE_DOMAIN}"`);
        for (const relay of RELAYS) {
            expect(dashboard).toContain(`{"relayId": "${relay.hostname}", "region": `);
            expect(dashboard).toContain(`'${relay.hostname}'`);
            expect(dashboard).toContain(`  ${relay.service}:\n    depends_on:\n      registry-keys:`);
        }
        expect(dashboard.split(`RELAY_REGISTRY_URL: ${DASHBOARD_ORIGIN}\n`)).toHaveLength(RELAYS.length + 1);
        expect(dashboard.split('RELAY_REGISTRY_FILE: !reset null\n')).toHaveLength(RELAYS.length + 1);
        expect(dashboard.split(`cat ${REGISTRY_TOKEN_FILE})`)).toHaveLength(RELAYS.length + 1);
        expect(dashboard).toContain(`PTBK_DASHBOARD_URL: ${DASHBOARD_ORIGIN}`);
        expect(dashboard.split(`profiles: [${ON_DEMAND_PROFILE}]`)).toHaveLength(3);
        const { heartbeatIntervalS, missedLimit, graceS, linkCodeTtlS } = DASHBOARD_TIMING;
        expect(dashboard).toContain(
            `"HEARTBEAT": {"intervalS": ${String(heartbeatIntervalS)}, "missedLimit": ${String(missedLimit)}, "graceS": ${String(graceS)},`,
        );
        expect(dashboard).toContain(`"LINK_CODE_TTL_S": ${String(linkCodeTtlS)}}`);
        expect(dashboard).toContain(`MOCK_HEARTBEAT_INTERVAL_S: '${String(heartbeatIntervalS)}'`);
        const mint = readFileSync(join(E2E_DIR, 'dashboard', 'mint-registry-keys.sh'), 'utf8');
        expect(mint).toContain(`chown ${String(SERVICE_UID)}:${String(SERVICE_UID)} `);
    });

    it('pins every image it pulls by digest', () => {
        const images = [compose, ...OVERLAYS.map(overlay)].flatMap((text) =>
            [...text.matchAll(/^\s+image: (\S+)$/gm)].map((match) => match[1]),
        );
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) expect(image).toMatch(/^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/);
        const dockerfile = readFileSync(join(E2E_DIR, 'docker', 'stack.Dockerfile'), 'utf8');
        const bases = [...dockerfile.matchAll(/^ARG \w+_IMAGE=(\S+)$/gm)].map((match) => match[1]);
        expect(bases).toHaveLength(4);
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
