import { rawTlsAttempt } from '../../src/certificates.ts';
import { expect, test } from '../../src/fixtures.ts';
import { ENGINE_DOMAIN, HTTPS_PORT } from '../../src/stack.ts';

const UNKNOWN_HOST = `unknown.${ENGINE_DOMAIN}`;

test('an unknown engine hostname fails to connect: the relay closes it without a byte', async ({
    page,
    relayHosts,
    compose,
}) => {
    await expect(page.goto(`https://${UNKNOWN_HOST}/`)).rejects.toThrow('net::ERR_CONNECTION_CLOSED');

    for (const relay of relayHosts) {
        const outcome = await rawTlsAttempt({ address: relay.ip, port: HTTPS_PORT, servername: UNKNOWN_HOST });
        expect(outcome, relay.hostname).toEqual({ kind: 'closed', bytesReceived: 0 });
        // The relay keeps no access log: a refused name never reaches its output.
        expect(await compose.logs(relay.service)).not.toContain(UNKNOWN_HOST);
    }
});

test("a relay's own hostname serves the relay's certificate and no engine content", async ({
    page,
    engineId,
    relayHosts,
    peerCertificateSha256,
}) => {
    for (const relay of relayHosts) {
        const response = await page.goto(`https://${relay.hostname}/`);
        const details = await response?.securityDetails();

        expect(response?.status()).toBe(404);
        expect(details?.subjectName).toBe(relay.hostname);
        expect(await peerCertificateSha256(page)).toBe(relay.certificateSha256);
        const body = (await response?.text()) ?? '';
        expect(body).not.toContain(engineId);
        expect(body).not.toContain('mock engine');
    }
});
