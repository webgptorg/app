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

/**
 * The UI release store (M-05): the files init signed and published, served over HTTPS like R2 or a mirror. The mock
 * engine's loader fetches its UI from here.
 */
export const RELEASE_STORE = {
    service: 'release-store',
    hostname: `releases.${OUR_DOMAIN}`,
    ip: '10.89.231.30',
} as const;

/**
 * The dashboard (X-05, compose.dashboard.yaml): D-01's dev container, with a certificate from the dev CA. The relays
 * read the registry from it and the mock engine registers with it and sends it heartbeats.
 */
export const DASHBOARD = { service: 'dashboard', hostname: `app.${OUR_DOMAIN}`, ip: '10.89.231.60' } as const;
export const DASHBOARD_ORIGIN = `https://${DASHBOARD.hostname}`;

/**
 * The dashboard stack's short timings, set in compose.dashboard.yaml: the engine beats every 15 s and counts as
 * offline after `missedLimit × intervalS + graceS` without one; link codes expire after 30 s instead of 30 minutes.
 */
export const DASHBOARD_TIMING = {
    heartbeatIntervalS: 15,
    missedLimit: 2,
    graceS: 5,
    linkCodeTtlS: 30,
} as const;

/** Where each relay of the dashboard stack reads the registry token minted for it (`registry-tokens` service). */
export const REGISTRY_TOKEN_FILE = '/registry-token/token';

/** The mock engine's dev-only control listener, plain HTTP on the stack network, for sessions and loader checks. */
export const MOCK_ENGINE_CONTROL = { ip: '10.89.231.31', port: 4480 } as const;

/** The UI versions init publishes: the first is pinned and installs, the second is tampered with after signing. */
export const UI_RELEASES = { installed: '0.0.0-dryrun.1', tampered: '0.0.0-dryrun.2' } as const;

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
    releases: '/releases',
    releaseStoreKey: '/release-store-key',
    /** The dashboard's TLS key (dashboard overlay only). */
    dashboardKey: '/dashboard-key',
    /** Where init's image holds the bundles X-03's `pack` built (stack.Dockerfile, `ui-bundle`). */
    uiBundles: '/ui-bundles',
} as const;

export const PUBLIC_FILES = {
    caCertificate: 'ca-cert.pem',
    /** The mock engine's `identity` report: `{ engineId, enginePublicKey, hostname }`. */
    engineIdentity: 'engine.json',
    registry: 'registry.json',
    /** The release store's certificate, issued by the dev CA. */
    releaseStoreCertificate: `${RELEASE_STORE.hostname}.pem`,
    /** The dashboard's certificate, issued by the dev CA (dashboard overlay only). */
    dashboardCertificate: `${DASHBOARD.hostname}.pem`,
    /** The UI loader's `TrustPolicy`: the public halves of release keys that existed only while init ran. */
    uiTrustPolicy: 'ui-trust-policy.json',
    /**
     * The root of Pebble's own HTTPS listeners (its fixed test "minica", copied from the Pebble image), not of the
     * certificates it issues: the mock engine trusts it for the ACME API, the probe and tests for the management API.
     */
    pebbleMinica: 'pebble-minica.pem',
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
/** Written by mitmproxy/record_websockets.py, next to the proxy's CA certificate (`ca-cert.pem`). */
export const MITM_FILES = { websocketMessages: 'websocket-messages.jsonl' } as const;

/**
 * The acme scenario's CA (M-03): Pebble, an ACME test server. Its own HTTPS certificate is issued to `pebble`, so
 * clients reach it under that name (compose `extra_hosts`). Its management API serves the root of the certificates it
 * issues, which is new on every start.
 */
export const PEBBLE = {
    service: 'pebble',
    hostname: 'pebble',
    ip: '10.89.231.40',
    acmePort: 14_000,
    managementPort: 15_000,
} as const;

/** Pebble's resolver: answers every A query with relay-a's address, as public DNS would send a CA to a relay. */
export const CHALLTESTSRV = { service: 'challtestsrv', ip: '10.89.231.41', dnsPort: 8053 } as const;

/** The validity Pebble gives certificates in the acme scenario, so the engine renews every minute (at 2/3). */
export const PEBBLE_VALIDITY_S = 90;

/** Resolves to both relays with `relay` first (coredns/Corefile), for tests that need a browser to try it first. */
export function relayFirstAlias(relay: RelayNode): string {
    return `${relay.service}-first.order.${OUR_DOMAIN}`;
}
