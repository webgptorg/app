import { X509Certificate } from 'node:crypto';

import { commonName } from '../../src/certificates.ts';
import { expect, test } from '../../src/fixtures.ts';

test('a browser loads the mock engine spike page through a relay', async ({
    page,
    engineId,
    spikeUrl,
    requestLog,
    cspViolations,
}) => {
    const response = await page.goto(spikeUrl);

    expect(response?.status()).toBe(200);
    await expect(page.locator('h1')).toHaveText('Promptbook mock engine');
    await expect(page.locator('#engine-id')).toHaveText(engineId);
    expect(response?.headers()['content-security-policy'], 'served under the engine CSP').toContain(
        "default-src 'self'",
    );
    const origin = new URL(spikeUrl).origin;
    expect(requestLog.length).toBeGreaterThan(0);
    expect(requestLog.filter((url) => new URL(url).origin !== origin)).toEqual([]);
    expect(cspViolations).toEqual([]);
});

test('the browser sees the engine certificate, never a relay certificate', async ({
    page,
    spikeUrl,
    engineHost,
    engineCertSha256,
    caCertificatePem,
    relayHosts,
    peerCertificate,
    peerCertificateSha256,
}) => {
    const response = await page.goto(spikeUrl);
    const details = await response?.securityDetails();
    const ca = new X509Certificate(caCertificatePem);

    expect(details?.subjectName).toBe(engineHost);
    expect(details?.issuer).toBe(commonName(ca.subject));

    const fingerprint = await peerCertificateSha256(page);
    expect(fingerprint).toBe(engineCertSha256);
    for (const relay of relayHosts) {
        expect(fingerprint, `differs from ${relay.hostname}'s certificate`).not.toBe(relay.certificateSha256);
    }

    const leaf = await peerCertificate(page);
    expect(leaf.checkHost(engineHost)).toBe(engineHost);
    expect(leaf.verify(ca.publicKey), 'signed by the dev CA, whose key only the engine holds').toBe(true);
});
