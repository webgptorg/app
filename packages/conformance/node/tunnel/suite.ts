import type { ConformanceCheck, ConformanceSuite } from '../../src/check';
import { TUNNEL_CHECKS, TUNNEL_SUITE_ID } from '../../src/suites/tunnel';
import { downgradeRefused, invalidMessageRefused } from './checks/handshake';
import { freshNonce, listEncoding, signatureVerifies, versionSigned, wrongRelayRefused } from './checks/auth';
import { everyRelay, relayCertificateVerified, websocketUpgrade } from './checks/dial';
import {
    ignorableIgnored,
    malformedRefused,
    streamIdRules,
    unknownTypeRefused,
    validFromEngine,
} from './checks/frames';
import { proxyConnect } from './checks/proxy';
import { afterClose, afterReject, backoff, relayRestart, replacedNoLoop } from './checks/reconnect';
import {
    closeHandling,
    concurrentStreams,
    grantsCredit,
    ping,
    sendWindow,
    tlsThroughTunnel,
    unknownSniRefused,
} from './checks/streams';
import type { TunnelCheckRun } from './checks/support';
import type { TunnelRuntime } from './runtime';

export const TUNNEL_CHECK_RUNS: Readonly<Record<string, TunnelCheckRun>> = {
    'tunnel.dial.websocket-upgrade': websocketUpgrade,
    'tunnel.dial.every-relay': everyRelay,
    'tunnel.auth.signature-verifies': signatureVerifies,
    'tunnel.auth.fresh-nonce': freshNonce,
    'tunnel.auth.version-signed': versionSigned,
    'tunnel.auth.list-encoding': listEncoding,
    'tunnel.stream.tls-through-tunnel': tlsThroughTunnel,
    'tunnel.stream.unknown-sni-refused': unknownSniRefused,
    'tunnel.stream.concurrent': concurrentStreams,
    'tunnel.flow.send-window': sendWindow,
    'tunnel.flow.grants-credit': grantsCredit,
    'tunnel.stream.close-handling': closeHandling,
    'tunnel.frames.ignorable-ignored': ignorableIgnored,
    'tunnel.frames.valid-from-engine': validFromEngine,
    'tunnel.liveness.ping': ping,
    'tunnel.auth.wrong-relay-refused': wrongRelayRefused,
    'tunnel.negotiation.downgrade-refused': downgradeRefused,
    'tunnel.handshake.invalid-message-refused': invalidMessageRefused,
    'tunnel.frames.unknown-type-refused': unknownTypeRefused,
    'tunnel.frames.malformed-refused': malformedRefused,
    'tunnel.frames.stream-id-rules': streamIdRules,
    'tunnel.dial.relay-certificate-verified': relayCertificateVerified,
    'tunnel.reconnect.after-close': afterClose,
    'tunnel.reconnect.relay-restart': relayRestart,
    'tunnel.reconnect.after-reject': afterReject,
    'tunnel.reconnect.backoff': backoff,
    'tunnel.reconnect.replaced-no-loop': replacedNoLoop,
    'tunnel.proxy.connect': proxyConnect,
};

/**
 * The tunnel suite acting as the relays the engine dials. `runtime` holds the fake relay and the engine; every check
 * starts from tunnels that are ready (or waits for them) and leaves them ready for the next.
 */
export function createTunnelSuite(runtime: TunnelRuntime): ConformanceSuite {
    return {
        id: TUNNEL_SUITE_ID,
        checks: TUNNEL_CHECKS.map((spec): ConformanceCheck => {
            const run = TUNNEL_CHECK_RUNS[spec.id];
            if (run === undefined) throw new Error(`no implementation for ${spec.id}`);
            return { ...spec, run: (check) => run({ runtime, check, signal: check.signal }) };
        }),
    };
}
