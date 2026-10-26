import { Resolver } from 'node:dns/promises';

import type { Browser, BrowserType } from '@playwright/test';

import { tlsPeerCertificate } from './certificates.ts';
import type { RelayNode } from './stack.ts';
import { DNS_IP, HTTPS_PORT, RELAYS, relayFirstAlias } from './stack.ts';

/**
 * A Chromium of its own whose resolver maps the engine hostname onto a name listing `relay` first, so the browser
 * tries that relay before the other one. Only the address lookup changes: the URL, the SNI and the certificate check
 * stay the engine's. The sandbox stays on, as in every other browser of this suite.
 */
export function launchPreferringRelay(chromium: BrowserType, engineHost: string, relay: RelayNode): Promise<Browser> {
    return chromium.launch({
        chromiumSandbox: true,
        args: [`--host-resolver-rules=MAP ${engineHost} ${relayFirstAlias(relay)}`],
    });
}

/** Whether `relay` routes the engine hostname to the engine right now: only the engine can complete this handshake. */
export async function relayServesEngine(
    relay: RelayNode,
    engineHost: string,
    caCertificatePem: string,
): Promise<boolean> {
    try {
        await tlsPeerCertificate({
            address: relay.ip,
            port: HTTPS_PORT,
            servername: engineHost,
            ca: caCertificatePem,
            timeoutMs: 2_000,
        });
        return true;
    } catch {
        return false;
    }
}

export async function everyRelayServesEngine(engineHost: string, caCertificatePem: string): Promise<boolean> {
    const results = await Promise.all(RELAYS.map((relay) => relayServesEngine(relay, engineHost, caCertificatePem)));
    return results.every(Boolean);
}

/**
 * The addresses the stack's DNS lists right now for the name `launchPreferringRelay(…, relay)` resolves, in order,
 * asked of CoreDNS directly so no cache in between hides a change. Empty when the lookup fails.
 */
export async function addressesListedFor(relay: RelayNode): Promise<readonly string[]> {
    const resolver = new Resolver({ timeout: 1_000, tries: 1 });
    resolver.setServers([DNS_IP]);
    try {
        return await resolver.resolve4(relayFirstAlias(relay));
    } catch {
        return [];
    }
}
