import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeBase64Url, deriveEngineId } from '@ptbk/protocol';
import type { Page } from '@playwright/test';

import {
    certificateSha256,
    commonName,
    leafFromCdpChain,
    rawTlsAttempt,
    tlsPeerCertificate,
} from '../../src/certificates.ts';
import { expect, isEngineUrl, test, uniqueEmail } from '../../src/dashboard.ts';
import { DASHBOARD_ORIGIN, ENGINE_DOMAIN, HTTPS_PORT, MOUNTS, PUBLIC_FILES, RELAYS } from '../../src/stack.ts';

// M3's done criterion: one engine, init's key, from sign-up to its page through a relay that found it in the
// dashboard's registry. The first test needs the engine still unlinked, so they run in order.
test.describe.configure({ mode: 'serial' });

const ONLINE_WITHIN_MS = 60_000;
// The first test leaves the engine ID in each relay's negative registry cache (30 s), and the engine backs off up to
// 10 s between tunnel attempts it loses to that.
const ROUTED_WITHIN_MS = 90_000;
// Once both tunnels are ready, each relay reports them within its 5-second window (R-07).
const REACHABLE_WITHIN_MS = 30_000;

async function stackEnginePublicKey(): Promise<Uint8Array<ArrayBuffer>> {
    const report = JSON.parse(await readFile(join(MOUNTS.public, PUBLIC_FILES.engineIdentity), 'utf8')) as {
        enginePublicKey?: unknown;
    };
    if (typeof report.enginePublicKey !== 'string') throw new Error('engine.json has no enginePublicKey');
    const decoded = decodeBase64Url(report.enginePublicKey);
    if (decoded.kind !== 'ok') throw new Error('engine.json: enginePublicKey is not base64url');
    return new Uint8Array(decoded.bytes);
}

/** The certificate Chromium accepted for the page, read through CDP (the page is reloaded under `Network.enable`). */
async function browserCertificate(page: Page): Promise<X509Certificate> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await page.reload();
    const { tableNames } = await cdp.send('Network.getCertificate', { origin: new URL(page.url()).origin });
    await cdp.detach();
    return leafFromCdpChain(tableNames);
}

test.beforeAll('the relays read their registry only from the dashboard', async ({ compose }) => {
    for (const relay of RELAYS) {
        const { env, mounts } = await compose.inspect(relay.service);
        expect(env, relay.service).toContain('RELAY_REGISTRY_KIND=http');
        expect(env, relay.service).toContain(`RELAY_REGISTRY_URL=${DASHBOARD_ORIGIN}`);
        expect(
            env.filter((entry) => entry.startsWith('RELAY_REGISTRY_FILE=')),
            relay.service,
        ).toEqual([]);
        expect(mounts.map((mount) => mount.destination)).not.toContain(join(MOUNTS.public, PUBLIC_FILES.registry));
        const found = await compose.exec(relay.service, ['test', '-e', join(MOUNTS.public, PUBLIC_FILES.registry)]);
        expect(found.exitCode, `${relay.service} sees no static registry file`).toBe(1);
        const logs = await compose.logs(relay.service);
        expect(logs).toMatch(/"event":"relay\.started".*"registry":"http"/);
        expect(logs).not.toContain('registry.loaded');
    }
});

test('before linking, the engine hostname does not connect: the relays do not know it', async ({
    page,
    engineHost,
    relayHosts,
}) => {
    await expect(page.goto(`https://${engineHost}/`)).rejects.toThrow('net::ERR_CONNECTION_CLOSED');
    for (const relay of relayHosts) {
        const outcome = await rawTlsAttempt({ address: relay.ip, port: HTTPS_PORT, servername: engineHost });
        expect(outcome, relay.hostname).toEqual({ kind: 'closed', bytesReceived: 0 });
    }
});

test('sign up with a passkey, link the engine, see it online, open it through a relay, sign in again', async ({
    page,
    dashboard,
    mockEngines,
    engineHost,
    caCertificatePem,
    relayHosts,
    requestLog,
    cspViolations,
}) => {
    test.setTimeout(240_000);

    await dashboard.signUp(uniqueEmail('link'));
    await dashboard.subscribe();
    const { installCommand, linkCode } = await dashboard.createLinkCode();
    expect(installCommand).toContain(linkCode);

    await mockEngines.start(linkCode, { key: 'stack' });

    // The hostname the dashboard shows must be the one the engine's own key derives.
    const engineId = await deriveEngineId(await stackEnginePublicKey());
    expect(engineHost).toBe(`${engineId}.${ENGINE_DOMAIN}`);
    await expect
        .poll(
            async () => {
                const row = (await dashboard.reloadEngineRows()).filter({ hasText: engineHost });
                return (await row.count()) === 1 ? row.getByText('Online', { exact: true }).count() : 0;
            },
            { timeout: ONLINE_WITHIN_MS, intervals: [1_000, 2_000] },
        )
        .toBe(1);
    const row = (await dashboard.reloadEngineRows()).filter({ hasText: engineHost });
    await expect(row.getByText(engineHost, { exact: true })).toBeVisible();

    // The dashboard's pages never touched an engine hostname, not even the list showing one.
    expect(requestLog.filter(isEngineUrl)).toEqual([]);
    expect(cspViolations.filter((violation) => isEngineUrl(violation.blockedUri))).toEqual([]);

    // Each relay looks the engine up in the dashboard's registry once its tunnel or a browser asks; wait until both
    // route it to the engine's own certificate.
    let engineCertSha256 = '';
    await expect
        .poll(
            async () => {
                const fingerprints = await Promise.all(
                    relayHosts.map((relay) =>
                        tlsPeerCertificate({
                            address: relay.ip,
                            port: HTTPS_PORT,
                            servername: engineHost,
                            ca: caCertificatePem,
                        }).then(certificateSha256, () => null),
                    ),
                );
                engineCertSha256 = fingerprints[0] ?? '';
                return fingerprints.every((fingerprint) => fingerprint !== null && fingerprint === fingerprints[0]);
            },
            { timeout: ROUTED_WITHIN_MS, intervals: [1_000, 2_000] },
        )
        .toBe(true);

    await expect
        .poll(
            async () =>
                (await dashboard.reloadEngineRows())
                    .filter({ hasText: engineHost })
                    .getByText('Reachable through 2 relays', { exact: true })
                    .count(),
            { timeout: REACHABLE_WITHIN_MS, intervals: [1_000, 2_000] },
        )
        .toBe(1);

    const open = row.getByRole('link', { name: /^Open engine/ });
    await expect(open).toHaveAttribute('href', `https://${engineHost}/`);
    const [enginePage] = await Promise.all([page.context().waitForEvent('page'), open.click()]);
    await enginePage.waitForLoadState('load');
    expect(new URL(enginePage.url()).hostname).toBe(engineHost);
    const certificate = await browserCertificate(enginePage);
    expect(certificateSha256(certificate)).toBe(engineCertSha256);
    expect(commonName(certificate.subject) ?? certificate.subjectAltName).toContain(engineHost);
    expect(certificate.checkIssued(new X509Certificate(caCertificatePem))).toBe(true);
    for (const relay of relayHosts) expect(certificateSha256(certificate)).not.toBe(relay.certificateSha256);
    await enginePage.close();

    await dashboard.signOut();
    await dashboard.signIn();
    await expect((await dashboard.reloadEngineRows()).getByText(engineHost, { exact: true })).toBeVisible();
});
