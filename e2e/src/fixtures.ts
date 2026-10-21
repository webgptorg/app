import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { test as base, expect } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

import { certificateSha256, leafFromCdpChain, tlsPeerCertificate } from './certificates.ts';
import type { ComposeControl } from './compose.ts';
import {
    DOCKER_SOCKET,
    createComposeControl,
    ownComposeProject,
    unixSocketStreamTransport,
    unixSocketTransport,
} from './compose.ts';
import type { RelayNode } from './stack.ts';
import { HTTPS_PORT, MOUNTS, PUBLIC_FILES, RELAYS, relayCertificateFile } from './stack.ts';

export { expect };

export interface RelayHost extends RelayNode {
    /** SHA-256 of the certificate init issued to this relay, read from the public volume. */
    readonly certificateSha256: string;
}

export interface CspViolation {
    readonly directive: string;
    readonly blockedUri: string;
    readonly sourceFile: string;
}

export interface WorkerFixtures {
    readonly engineId: string;
    /** `<engineId>.engine.test`. */
    readonly engineHost: string;
    /** `https://<engineHost>/`: the app, behind the gateway (anonymous visitors are sent to sign in). */
    readonly engineUrl: string;
    /** `https://<engineHost>/__spike/`: the mock engine's public spike page. */
    readonly spikeUrl: string;
    /** The dev CA certificate (PEM) Chromium trusts through its NSS database. */
    readonly caCertificatePem: string;
    readonly relayHosts: readonly RelayHost[];
    /**
     * SHA-256 of the certificate a verifying TLS client gets for the engine hostname. Fetched through every relay and
     * required to be identical: relays that each substituted a certificate would have to agree on one.
     */
    readonly engineCertSha256: string;
    readonly compose: ComposeControl;
}

export interface TestFixtures {
    /** The certificate Chromium accepted for the page's origin, read through CDP `Network.getCertificate`. */
    readonly peerCertificate: (page: Page) => Promise<X509Certificate>;
    readonly peerCertificateSha256: (page: Page) => Promise<string>;
    /** Every request URL the page made, in order, for "no foreign origin" assertions. */
    readonly requestLog: readonly string[];
    /** Every `securitypolicyviolation` the page reported, collected from before any page script runs. */
    readonly cspViolations: readonly CspViolation[];
}

const CSP_BINDING = '__ptbkE2eCspViolation';

function readPublic(name: string): Promise<string> {
    return readFile(join(MOUNTS.public, name), 'utf8');
}

async function readIdentity(): Promise<{ engineId: string; hostname: string }> {
    const report = JSON.parse(await readPublic(PUBLIC_FILES.engineIdentity)) as {
        engineId?: unknown;
        hostname?: unknown;
    };
    if (typeof report.engineId !== 'string' || typeof report.hostname !== 'string') {
        throw new Error(`${PUBLIC_FILES.engineIdentity} is not init's identity report`);
    }
    return { engineId: report.engineId, hostname: report.hostname };
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
    engineId: [
        async ({}, use) => {
            await use((await readIdentity()).engineId);
        },
        { scope: 'worker' },
    ],
    engineHost: [
        async ({}, use) => {
            await use((await readIdentity()).hostname);
        },
        { scope: 'worker' },
    ],
    engineUrl: [
        async ({ engineHost }, use) => {
            await use(`https://${engineHost}/`);
        },
        { scope: 'worker' },
    ],
    spikeUrl: [
        async ({ engineUrl }, use) => {
            await use(`${engineUrl}__spike/`);
        },
        { scope: 'worker' },
    ],
    caCertificatePem: [
        async ({}, use) => {
            await use(await readPublic(PUBLIC_FILES.caCertificate));
        },
        { scope: 'worker' },
    ],
    relayHosts: [
        async ({}, use) => {
            const hosts = await Promise.all(
                RELAYS.map(async (relay) => ({
                    ...relay,
                    certificateSha256: certificateSha256(
                        new X509Certificate(await readPublic(relayCertificateFile(relay))),
                    ),
                })),
            );
            await use(hosts);
        },
        { scope: 'worker' },
    ],
    engineCertSha256: [
        async ({ engineHost, caCertificatePem }, use) => {
            const fingerprints = await Promise.all(
                RELAYS.map(async (relay) =>
                    certificateSha256(
                        await tlsPeerCertificate({
                            address: relay.ip,
                            port: HTTPS_PORT,
                            servername: engineHost,
                            ca: caCertificatePem,
                        }),
                    ),
                ),
            );
            expect(new Set(fingerprints).size, 'every relay delivers the same engine certificate').toBe(1);
            await use(fingerprints[0] ?? '');
        },
        { scope: 'worker' },
    ],
    compose: [
        async ({}, use) => {
            const transport = unixSocketTransport(DOCKER_SOCKET);
            await use(
                createComposeControl(
                    transport,
                    await ownComposeProject(transport, hostname()),
                    unixSocketStreamTransport(DOCKER_SOCKET),
                ),
            );
        },
        { scope: 'worker' },
    ],

    peerCertificate: async ({ page }, use) => {
        // Chromium answers Network.getCertificate only for origins it loaded while the Network domain was enabled, so
        // the test's page gets its session before the first navigation; other pages get one on first use.
        const sessions = new Map<Page, CDPSession>();
        const sessionOf = async (target: Page): Promise<CDPSession> => {
            let session = sessions.get(target);
            if (session === undefined) {
                session = await target.context().newCDPSession(target);
                await session.send('Network.enable');
                sessions.set(target, session);
            }
            return session;
        };
        await sessionOf(page);
        await use(async (target) => {
            const session = await sessionOf(target);
            const { tableNames } = await session.send('Network.getCertificate', {
                origin: new URL(target.url()).origin,
            });
            return leafFromCdpChain(tableNames);
        });
        for (const session of sessions.values()) await session.detach().catch(() => undefined);
    },
    peerCertificateSha256: async ({ peerCertificate }, use) => {
        await use(async (page) => certificateSha256(await peerCertificate(page)));
    },
    requestLog: async ({ page }, use) => {
        const urls: string[] = [];
        page.on('request', (request) => urls.push(request.url()));
        await use(urls);
    },
    cspViolations: async ({ page }, use) => {
        const violations: CspViolation[] = [];
        await page.exposeBinding(CSP_BINDING, (_source, violation: CspViolation) => {
            violations.push(violation);
        });
        await page.addInitScript((binding) => {
            document.addEventListener('securitypolicyviolation', (event) => {
                const report = (window as unknown as Record<string, (violation: unknown) => void>)[binding];
                report?.({
                    directive: event.effectiveDirective,
                    blockedUri: event.blockedURI,
                    sourceFile: event.sourceFile,
                });
            });
        }, CSP_BINDING);
        await use(violations);
    },
});
