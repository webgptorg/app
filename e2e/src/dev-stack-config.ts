// The local dev stack for humans (X-06): what `dev:stack`, `dev:link`, `dev:trust` and the smoke test share. Ports
// are repeated in compose.dev.yaml and coredns/Corefile.host; dev-stack.test.ts fails if they drift apart. Only node:
// imports, so it runs before (and without) an install.
import { join } from 'node:path';

import type { ComposeTarget } from './docker.ts';
import { STACK_NET } from './stack.ts';

/** Its own compose project, so `e2e:down` of a worktree never touches it, and its volumes survive `down`. */
export const DEV_PROJECT = 'ptbk-dev';
export const DEV_OVERLAYS: readonly string[] = ['dashboard', 'dev'];
/** Not started by `up`; `dev:stack up` starts it once it holds a registration, `dev:link` registers it. */
export const DEV_ENGINE_SERVICE = 'mock-engine';
export const DEV_ON_DEMAND_PROFILE = 'on-demand';

/** Every published port, on 127.0.0.1 only. */
export const DEV_PORTS = {
    /** relay-a: the engine "Open" link has no port, so a trusting host needs 443. */
    relay: 443,
    /** relay-a with `--no-system`, mapped to by Chromium's --host-resolver-rules. */
    noSystemRelay: 8443,
    dashboard: 8444,
    /** The resolver for the host (5353 is mDNS on macOS). */
    dns: 1053,
} as const;

export const DEV_DASHBOARD_HOST = 'app.ptbk.test';
export const DEV_DASHBOARD_ORIGIN = `https://${DEV_DASHBOARD_HOST}:${String(DEV_PORTS.dashboard)}`;
export const DEV_ENGINE_DOMAIN = 'engine.test';
/** The dev CA's name constraints: the engine domain and our test domain, which holds the relays and the dashboard. */
export const DEV_CA_DOMAINS: readonly string[] = [DEV_ENGINE_DOMAIN, 'ptbk.test'];

/** Git-ignored, next to the checkout's sources: the persistent dev CA and the --no-system Chromium profile. */
export const DEV_DIR = '.dev';
export const DEV_PKI_DIR = join(DEV_DIR, 'pki');
/** Where the mock engine's `dev-ca`, run with `PTBK_DATA_DIR` = DEV_PKI_DIR, keeps the CA. */
export const DEV_CA_CERT_FILE = join(DEV_PKI_DIR, 'dev-ca', 'ca-cert.pem');
export const DEV_CHROMIUM_PROFILE = join(DEV_DIR, 'chromium');

/** The compose variable holding the stack network's first three octets (compose.yaml). */
export const STACK_NET_VARIABLE = 'PTBK_STACK_NET';
/**
 * The dev stack's network, so it runs next to any e2e stack: clear of e2e's stack network (src/stack.ts, STACK_NET)
 * and of the nat scenarios' engine LAN (ENGINE_LAN_SUBNET), which the dev stack never layers.
 */
export const DEV_STACK_NET = '10.89.241';
export const DEV_SUBNET = `${DEV_STACK_NET}.0/24`;
/** coredns/ with its addresses moved onto DEV_STACK_NET; compose.dev.yaml mounts it as the stack resolver's config. */
export const DEV_COREDNS_DIR = join(DEV_DIR, 'coredns');

const E2E_STACK_ADDRESS = new RegExp(`(?<![\\d.])${STACK_NET.replaceAll('.', '\\.')}\\.(\\d{1,3})(?!\\d)`, 'g');

/**
 * A CoreDNS file of the e2e stack (Corefile, zone file) for a stack on `stackNet`: every address on the e2e stack
 * network moves there, host part kept. The e2e files stay the only source, whatever they serve the names with.
 */
export function moveStackAddresses(text: string, stackNet: string): string {
    return text.replace(E2E_STACK_ADDRESS, (_match, host: string) => `${stackNet}.${host}`);
}

/**
 * Why `up` must not reuse the project's existing stack network, from `docker network inspect --format` listing its
 * subnets; null when it is already on `subnet`. A stack created before X-08 sits on e2e's subnet and has to come down
 * once, which compose would not say clearly.
 */
export function staleNetwork(inspectedSubnets: string, subnet: string): string | null {
    const subnets = inspectedSubnets.split(/\s+/).filter((entry) => entry !== '');
    if (subnets.length === 0 || subnets.every((entry) => entry === subnet)) return null;
    return `the dev stack's network is still on ${subnets.join(', ')}, not ${subnet}; run \`bun run dev:stack down\`, then \`up\` again (your account, passkeys and linked engine stay)`;
}

export function devTarget(e2eDir: string): ComposeTarget {
    return { project: DEV_PROJECT, e2eDir, overlays: DEV_OVERLAYS, scenario: 'dev', onDemand: [DEV_ENGINE_SERVICE] };
}

export type DevStackCommand =
    | { readonly kind: 'up'; readonly noSystem: boolean }
    | { readonly kind: 'down' }
    | { readonly kind: 'reset' }
    | { readonly kind: 'logs'; readonly services: readonly string[] };

export const DEV_STACK_USAGE = 'usage: bun run dev:stack up [--no-system] | down | reset | logs [service...]';

export function parseDevStackArgs(args: readonly string[]): DevStackCommand | null {
    const [verb, ...rest] = args;
    switch (verb) {
        case 'up':
            if (rest.some((arg) => arg !== '--no-system')) return null;
            return { kind: 'up', noSystem: rest.includes('--no-system') };
        case 'down':
        case 'reset':
            return rest.length === 0 ? { kind: verb } : null;
        case 'logs':
            return rest.every((service) => /^[a-z0-9-]+$/.test(service)) ? { kind: 'logs', services: rest } : null;
        case undefined:
        default:
            return null;
    }
}

// `@ptbk/protocol`'s `LinkCode`; the CLI runs under plain Node, which cannot load the workspace's TypeScript sources.
const LINK_CODE = '[a-z2-7]{25}[aeimquy4]';
const DEV_LINK = new RegExp(`^(?:${DEV_DASHBOARD_ORIGIN.replaceAll('.', '\\.')}/link#)?${LINK_CODE}$`);

/**
 * The code from the dashboard's install command, or the dev stack's own link URL, checked before it goes anywhere near
 * a container. A link URL for another dashboard is refused here; the engine would refuse it too.
 */
export function parseLinkCode(args: readonly string[]): string | null {
    const [value, ...rest] = args;
    return value !== undefined && rest.length === 0 && DEV_LINK.test(value) ? value : null;
}

/**
 * Chromium for the `--no-system` path: its own profile, the stack's names mapped to the published loopback ports and
 * every other name unresolvable, so the profile reaches nothing but the stack. A profile cannot hold its own trust
 * anchor on macOS, so it ignores certificate errors instead; the resolver rules keep that to the stack's own servers.
 */
export function chromiumArgs(profileDir: string, relayPort: number): readonly string[] {
    return [
        `--user-data-dir=${profileDir}`,
        '--ignore-certificate-errors',
        `--host-resolver-rules=MAP ${DEV_DASHBOARD_HOST} 127.0.0.1:${String(DEV_PORTS.dashboard)}, MAP *.${DEV_ENGINE_DOMAIN} 127.0.0.1:${String(relayPort)}, MAP * ~NOTFOUND`,
        '--no-first-run',
        '--no-default-browser-check',
    ];
}

const CHROME_BINARIES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: 'google-chrome',
};

/** A line to paste into a shell: Chrome with {@link chromiumArgs}, opening the dashboard. */
export function chromiumLaunchLine(platform: NodeJS.Platform, profileDir: string, relayPort: number): string {
    const binary = CHROME_BINARIES[platform] ?? 'chromium';
    return [binary, ...chromiumArgs(profileDir, relayPort), `${DEV_DASHBOARD_ORIGIN}/`]
        .map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`)
        .join(' ');
}

interface PublishedPort {
    readonly host_ip?: unknown;
    readonly published?: unknown;
    readonly target?: unknown;
}

/** Every published port of a `docker compose config --format json` that is not bound to 127.0.0.1, as `service:port`. */
export function nonLoopbackPorts(config: unknown): readonly string[] {
    const services = (config as { services?: unknown } | null)?.services;
    if (typeof services !== 'object' || services === null) throw new Error('not a compose config');
    return Object.entries(services as Record<string, { ports?: readonly PublishedPort[] }>).flatMap(
        ([service, definition]) =>
            (definition.ports ?? [])
                .filter((port) => port.host_ip !== '127.0.0.1')
                .map((port) => `${service}:${String(port.published ?? port.target)}`),
    );
}
