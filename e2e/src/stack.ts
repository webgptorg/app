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

/**
 * X-02's network scenarios put the mock engine on its own `internal` network with no way out except the gateway
 * (NAT and firewall) or a proxy. Nothing on the stack network has a route into it.
 */
export const ENGINE_LAN_SUBNET = '10.89.232.0/24';

export interface DualHomedNode {
    readonly service: string;
    /** Its address on the stack network: what relays and the browser side see. */
    readonly publicIp: string;
    readonly lanIp: string;
}

export const GATEWAY: DualHomedNode = { service: 'gateway', publicIp: '10.89.231.20', lanIp: '10.89.232.2' };
export const CONNECT_PROXY: DualHomedNode = { service: 'proxy', publicIp: '10.89.231.21', lanIp: '10.89.232.3' };
export const TLS_INSPECTING_PROXY: DualHomedNode = {
    service: 'mitmproxy',
    publicIp: '10.89.231.22',
    lanIp: '10.89.232.4',
};

/** The engine's host: owns the network namespace the mock engine joins, and serves a few ports on the LAN. */
export const ENGINE_HOST = { service: 'engine-net', ip: '10.89.232.10' } as const;
/** Ports the engine host listens on, so "nothing reaches the engine from outside" is tested against open ports. */
export const ENGINE_HOST_PORTS: readonly number[] = [443, 8080];
/** A second port on relay-a's address (egress-443 overlay), open to everyone but the engine. */
export const RELAY_OTHER_PORT = 8443;

export const CONNECT_PROXY_PORT = 3128;
export const TLS_INSPECTING_PROXY_PORT = 8080;

/** Read-only for the playwright service: the relay-a capture and mitmproxy's record of the tunnel WebSockets. */
export const CAPTURE_MOUNT = '/captures';
export const RELAY_A_CAPTURE_FILE = 'relay-a.pcap';
export const MITM_MOUNT = '/mitm';
export const MITM_FILES = {
    caCertificate: 'ca-cert.pem',
    websocketMessages: 'websocket-messages.jsonl',
} as const;

/** Resolves to both relays with `relay` first (coredns/Corefile), for tests that need a browser to try it first. */
export function relayFirstAlias(relay: RelayNode): string {
    return `${relay.service}-first.order.${OUR_DOMAIN}`;
}
