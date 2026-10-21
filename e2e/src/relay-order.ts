import type { Browser, BrowserType } from '@playwright/test';

import { tlsPeerCertificate } from './certificates.ts';
import type { RelayNode } from './stack.ts';
import { HTTPS_PORT, RELAYS, relayFirstAlias } from './stack.ts';

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
