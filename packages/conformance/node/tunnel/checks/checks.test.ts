import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../../src/check';
import { CheckFailure, CheckSkip } from '../../../src/check';
import { startFakeRelay } from '../../fake-relay/fake-relay';
import { createTestCa } from '../../pki/test-ca';
import type { FakeTunnelEngineOptions, TunnelDefect } from '../../testing/tunnel-fake-engine';
import { TUNNEL_DEFECTS, startFakeTunnelEngine } from '../../testing/tunnel-fake-engine';
import { TUNNEL_CHECKS } from '../../suites/tunnel';
import type { TunnelTiming } from '../runtime';
import { TunnelRuntime } from '../runtime';
import { relayIdsFor } from '../tunnel-relay';
import { TUNNEL_CHECK_RUNS } from '.';

const ENGINE_DOMAIN = Hostname.parse('engine.localhost');

/** Scaled to an in-process engine that pings every 300 ms and backs off from 50 ms; the contract's are far longer. */
const TIMING: TunnelTiming = {
    authMs: 2_000,
    reconnectMs: 3_000,
    relayRestartMs: 3_000,
    shuttingDownMs: 1_500,
    closeMs: 1_000,
    observeMs: 600,
    replacedObserveMs: 1_500,
    quietMs: 200,
    pingMs: 800,
    minBackoffSpreadMs: 300,
    requestMs: 3_000,
};

async function runCheck(
    id: string,
    defects: readonly TunnelDefect[] = [],
    offer?: FakeTunnelEngineOptions['offer'],
): Promise<CheckOutcome> {
    const run = TUNNEL_CHECK_RUNS[id];
    if (run === undefined) throw new Error(`no check ${id}`);
    const ca = createTestCa('relay test CA', { permittedDomains: ['localhost'] });
    const relay = await startFakeRelay({ relayIds: relayIdsFor(3), trustedCa: ca });
    const runtime = new TunnelRuntime(relay, ENGINE_DOMAIN, TIMING);
    const engine = await startFakeTunnelEngine({
        relayUrls: relay.relayIds.map((relayId) => relay.url(relayId)),
        relayCaPem: ca.certPem,
        engineDomain: ENGINE_DOMAIN,
        defects,
        pingIntervalMs: 300,
        // Fast everywhere, except where backoff is what is measured: there, a correct engine falls under the 300 ms
        // threshold with a probability of about 4 × 10⁻⁵, and a tight loop stays far below it even on a busy machine.
        ...(id === 'tunnel.reconnect.backoff'
            ? { backoffBaseMs: 300, backoffCapMs: 1_500 }
            : { backoffBaseMs: 50, backoffCapMs: 400 }),
        ...(offer === undefined ? {} : { offer }),
    });
    runtime.attach(engine);
    const signal = AbortSignal.timeout(30_000);
    try {
        await runtime.waitAllReady(2_000, signal);
        return await run({ runtime, signal, session: () => Promise.resolve(null) });
    } catch (error) {
        if (error instanceof CheckFailure) return { kind: 'fail', detail: error.message };
        if (error instanceof CheckSkip) return { kind: 'skip', reason: error.message };
        throw error;
    } finally {
        await engine.stop();
        await relay.close();
    }
}

/** For each check, the defects it must catch. */
const CAUGHT_BY: Readonly<Record<string, readonly TunnelDefect[]>> = {
    'tunnel.dial.websocket-upgrade': ['wrong-subprotocol'],
    'tunnel.dial.every-relay': ['dial-only-first', 'duplicate-tunnels', 'one-handshake-at-a-time'],
    'tunnel.auth.signature-verifies': [
        'wrong-key',
        'silent-challenge',
        'close-on-challenge',
        'garbage-auth',
        'other-identity',
        'version-2-only',
    ],
    'tunnel.auth.fresh-nonce': ['reuse-first-auth', 'wrong-key', 'version-2-only'],
    'tunnel.auth.version-signed': ['omit-version', 'wrong-key'],
    'tunnel.auth.list-encoding': ['unsorted-lists', 'wrong-key', 'refuse-unknown-features'],
    'tunnel.stream.tls-through-tunnel': [
        'tls12-only',
        'wrong-certificate-name',
        'refuse-streams',
        'wrong-api-answer',
        'no-http-answer',
    ],
    'tunnel.stream.unknown-sni-refused': ['default-certificate', 'close-tunnel-on-bad-sni'],
    'tunnel.stream.concurrent': ['max-four-streams', 'refuse-streams', 'no-http-answer'],
    'tunnel.flow.send-window': ['ignore-window', 'ignore-window-frames', 'refuse-streams'],
    'tunnel.flow.grants-credit': ['never-grant', 'refuse-streams'],
    'tunnel.stream.close-handling': [
        'no-close-frame',
        'ignore-relay-close',
        'refuse-streams',
        'no-http-answer',
        'fail-on-late-frame',
    ],
    'tunnel.frames.ignorable-ignored': ['fail-on-ignorable', 'refuse-streams', 'wrong-api-answer', 'no-http-answer'],
    'tunnel.frames.valid-from-engine': [
        'oversized-frames',
        'engine-opens-stream',
        'overgrant',
        'text-after-ready',
        'frame-for-unknown-stream',
        'ignorable-from-engine',
        'refuse-streams',
        'no-http-answer',
    ],
    'tunnel.liveness.ping': ['no-ping'],
    'tunnel.auth.wrong-relay-refused': ['ignore-relay-id', 'silent-wrong-relay'],
    'tunnel.negotiation.downgrade-refused': ['accept-any-ready', 'wrong-close-code', 'silent-challenge'],
    'tunnel.handshake.invalid-message-refused': [
        'ignore-invalid-messages',
        'wrong-close-code',
        'lenient-challenge',
        'version-2-only',
    ],
    'tunnel.frames.unknown-type-refused': ['ignore-unknown-types', 'wrong-close-code'],
    'tunnel.frames.malformed-refused': ['crash-on-malformed', 'wrong-close-code'],
    'tunnel.frames.stream-id-rules': ['allow-duplicate-open', 'wrong-close-code'],
    'tunnel.dial.relay-certificate-verified': ['skip-relay-verification', 'stop-after-close'],
    'tunnel.reconnect.after-close': ['stop-after-close'],
    'tunnel.reconnect.relay-restart': ['stop-after-close', 'dial-only-first'],
    'tunnel.reconnect.after-reject': ['stop-after-reject', 'auth-again-after-reject'],
    'tunnel.reconnect.backoff': ['tight-loop', 'stop-after-reject'],
    'tunnel.reconnect.replaced-no-loop': ['reconnect-after-replaced'],
    'tunnel.proxy.connect': [
        'ignore-proxy',
        'proxy-no-credentials',
        'ignore-no-proxy',
        'leak-proxy-password',
        'skip-relay-verification',
    ],
};

describe('the tunnel checks against an in-process engine', () => {
    it('cover every check and every defect', () => {
        expect(Object.keys(CAUGHT_BY).sort()).toEqual(TUNNEL_CHECKS.map(({ id }) => id).sort());
        expect(new Set(Object.values(CAUGHT_BY).flat())).toEqual(new Set(TUNNEL_DEFECTS));
    });

    it('downgrade-refused also tries a lower common version and a missing feature when the engine offers them', async () => {
        const offer = { protocolVersions: [1, 2], features: ['x-test'] };
        expect(await runCheck('tunnel.negotiation.downgrade-refused', [], offer)).toEqual({ kind: 'pass' });
        expect((await runCheck('tunnel.negotiation.downgrade-refused', ['accept-any-ready'], offer)).kind).toBe('fail');
    });

    for (const { id } of TUNNEL_CHECKS) {
        it(`${id} passes a correct engine`, async () => {
            expect(await runCheck(id)).toEqual({ kind: 'pass' });
        });
        for (const defect of CAUGHT_BY[id] ?? []) {
            it(`${id} fails an engine with ${defect}`, async () => {
                expect((await runCheck(id, [defect])).kind).toBe('fail');
            });
        }
    }
});
