import { expect, test } from '../../src/fixtures.ts';
import { tcpAttemptFrom } from '../../src/service-events.ts';
import { ENGINE_HOST, HTTPS_PORT, RELAYS, RELAY_OTHER_PORT } from '../../src/stack.ts';
import { LISTENER_BANNER, tcpAttempt } from '../../src/tcp-check.ts';

const ATTEMPT_TIMEOUT_MS = 3_000;

test('the engine page loads when the engine may only leave its network on TCP 443', async ({
    page,
    engineId,
    engineUrl,
}) => {
    const response = await page.goto(engineUrl);
    expect(response?.status()).toBe(200);
    await expect(page.locator('#engine-id')).toHaveText(engineId);
});

test("the engine cannot reach a relay's address on another port, though that port is open", async ({ compose }) => {
    const relayA = RELAYS[0];
    if (relayA === undefined) throw new Error('the stack has no relay');
    const other = { host: relayA.ip, port: RELAY_OTHER_PORT };

    // Positive controls: the port answers anyone outside the engine LAN, and the engine's namespace reaches 443.
    const fromOutside = await tcpAttempt(other.host, other.port, ATTEMPT_TIMEOUT_MS);
    expect(fromOutside.outcome).toBe('connected');
    expect(fromOutside.banner).toContain(LISTENER_BANNER);
    const https = await tcpAttemptFrom(compose, ENGINE_HOST.service, { host: relayA.ip, port: HTTPS_PORT }, 3_000);
    expect(https.outcome, 'engine -> relay-a:443').toBe('connected');

    const fromEngine = await tcpAttemptFrom(compose, ENGINE_HOST.service, other, ATTEMPT_TIMEOUT_MS);
    expect(fromEngine.outcome, `engine -> relay-a:${String(RELAY_OTHER_PORT)}`).toBe('timeout');
});
