import type { TunnelAuth } from '@ptbk/protocol';
import { TunnelAuth as TunnelAuthSchema, encodeBase64Url } from '@ptbk/protocol';

import type { FakeConnection, PendingDial } from './fake-dialer';
import { flush, until } from './fake-dialer';

/**
 * Plays the relay's side of C-02's handshake on a pending dial (challenge, the engine's signed `auth`, `ready`), so the
 * engine's link reaches `ready` with `hostnames` confirmed.
 */
export async function completeHandshake(
    dial: PendingDial | undefined,
    hostnames: readonly string[],
    nonceByte = 1,
): Promise<{ readonly connection: FakeConnection; readonly auth: TunnelAuth }> {
    if (dial === undefined) throw new Error('no dial');
    const connection = dial.open();
    await flush();
    connection.relayJson({
        v: 1,
        type: 'challenge',
        nonce: encodeBase64Url(new Uint8Array(32).fill(nonceByte)),
        relayId: dial.target.relayId,
        protocolVersions: [1],
        features: [],
    });
    await until(() => connection.texts.length === 1);
    const auth = TunnelAuthSchema.parse(JSON.parse(connection.texts[0] ?? ''));
    connection.relayJson({ v: 1, type: 'ready', protocolVersion: 1, features: [], hostnames: [...hostnames] });
    return { connection, auth };
}
