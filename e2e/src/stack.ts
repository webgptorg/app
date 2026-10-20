/*
 * The topology every e2e scenario shares. compose.yaml and coredns/Corefile repeat the addresses (neither can import
 * this file); stack.test.ts fails when they drift apart.
 */

/** `.test` is reserved (RFC 6761): `ptbk.test` stands in for our domain, `engine.test` for the engine domain. */
export const OUR_DOMAIN = 'ptbk.test';
export const ENGINE_DOMAIN = 'engine.test';

export const SUBNET = '10.89.231.0/24';
export const DNS_IP = '10.89.231.53';

export interface RelayNode {
    /** The compose service name. */
    readonly service: string;
    readonly hostname: string;
    readonly ip: string;
}

export const RELAYS: readonly RelayNode[] = [
    { service: 'relay-a', hostname: `relay-a.${OUR_DOMAIN}`, ip: '10.89.231.11' },
    { service: 'relay-b', hostname: `relay-b.${OUR_DOMAIN}`, ip: '10.89.231.12' },
];

/** Every relay and the browser listen on 443, as in production. */
export const HTTPS_PORT = 443;

/**
 * Mount points of init's volumes. `public` holds only public material (the CA certificate, relay certificates, the
 * engine's identity and the registry) and is mounted read-only everywhere else; private keys live in volumes that
 * only their owner mounts.
 */
export const MOUNTS = {
    public: '/pki',
    engine: '/engine',
    relayKeys: '/relay-keys',
} as const;

export const PUBLIC_FILES = {
    caCertificate: 'ca-cert.pem',
    /** The mock engine's `identity` report: `{ engineId, enginePublicKey, hostname }`. */
    engineIdentity: 'engine.json',
    registry: 'registry.json',
} as const;

export function relayCertificateFile(relay: RelayNode): string {
    return `${relay.hostname}.pem`;
}

/** The uid of the `node` user in the relay and mock engine images; init hands every volume to it. */
export const SERVICE_UID = 1000;
