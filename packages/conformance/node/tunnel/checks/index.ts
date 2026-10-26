import { downgradeRefused, invalidMessageRefused } from './handshake';
import { freshNonce, listEncoding, signatureVerifies, versionSigned, wrongRelayRefused } from './auth';
import { everyRelay, relayCertificateVerified, websocketUpgrade } from './dial';
import { ignorableIgnored, malformedRefused, streamIdRules, unknownTypeRefused, validFromEngine } from './frames';
import { proxyConnect } from './proxy';
import { afterClose, afterReject, backoff, relayRestart, replacedNoLoop } from './reconnect';
import {
    closeHandling,
    concurrentStreams,
    grantsCredit,
    ping,
    sendWindow,
    tlsThroughTunnel,
    unknownSniRefused,
} from './streams';
import type { TunnelCheckRun } from './support';

/** Every tunnel check by its ID; the suite in node/suites/tunnel gives each a relay and an engine. */
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
