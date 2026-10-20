import type { Hostname } from '@ptbk/protocol';
import { CLOSE_CODE, TUNNEL_FEATURES, TUNNEL_PROTOCOL_VERSIONS, TunnelFeature, defaultHostname } from '@ptbk/protocol';

import { createHttpApp } from '../adapters/http/http-app';
import { createSpikeRoutes } from '../adapters/http/spike-routes';
import { createTlsStreamServer } from '../adapters/tls-stream-server';
import type { TunnelDuplex } from '../adapters/tunnel-duplex';
import { openTunnelDuplex } from '../adapters/tunnel-duplex';
import type { Clock } from '../domain/clock';
import type { EngineIdentity, IdentityStore } from '../domain/identity/engine-identity';
import type { Logger } from '../domain/logger';
import type { Random } from '../domain/random';
import { createWindowRateLimiter } from '../domain/rate-limit/rate-limiter';
import type { ManagedCertificateSource } from '../domain/tls/certificate-source';
import type { RelayDialer } from '../domain/tunnel/relay-dialer';
import type { RelayLink, RelayLinkState, TunnelOfferConfig } from '../domain/tunnel/relay-link';
import { createRelayLink } from '../domain/tunnel/relay-link';
import type { RelayTarget } from '../domain/tunnel/relay-target';
import type { StreamEvents } from '../domain/tunnel/tunnel-stream';
import type { MockEngineConfig } from './config';

/** Everything `@ptbk/protocol` implements, so the mock always advertises exactly the current contract. */
export const DEFAULT_TUNNEL_OFFER: TunnelOfferConfig = Object.freeze({
    protocolVersions: Object.freeze([...TUNNEL_PROTOCOL_VERSIONS]),
    features: Object.freeze(TunnelFeature.array().parse([...TUNNEL_FEATURES])),
});

export interface MockEngineDeps {
    readonly logger: Logger;
    readonly clock: Clock;
    readonly random: Random;
    readonly identityStore: IdentityStore;
    readonly dialer: RelayDialer;
    readonly offer?: TunnelOfferConfig;
    readonly onLinkState?: (relay: RelayTarget, state: RelayLinkState) => void;
    /**
     * Certificates for the engine's hostnames; `close` stops them too. With it, every stream is served by the TLS
     * server and HTTP app inside the tunnel; without it (tunnel-only tests), streams go to `onStream` handlers or are
     * refused.
     */
    readonly certificates?: ManagedCertificateSource;
}

/** A browser connection through `relay`; the TLS server inside the tunnel takes it from here. */
export type StreamHandler = (stream: TunnelDuplex, relay: RelayTarget) => void;

export interface MockEngine {
    readonly identity: EngineIdentity;
    /** `<engineId>.<engine domain>`. */
    readonly hostname: Hostname;
    /** One per configured relay, each independent of the others. */
    readonly links: readonly RelayLink[];
    /**
     * Replaces the stream handler (the TLS server, if `certificates` was given); returns a function that restores it.
     * Without any handler streams are refused.
     */
    onStream(handler: StreamHandler): () => void;
    /** Closes every tunnel cleanly and stops reconnecting. */
    close(): Promise<void>;
}

function ignore(): void {
    // A refused stream is closed before the mux could deliver anything to it.
}
const REFUSED_EVENTS: StreamEvents = Object.freeze({ data: ignore, sendCredit: ignore, closed: ignore });

export async function startMockEngine(config: MockEngineConfig, deps: MockEngineDeps): Promise<MockEngine> {
    const { logger } = deps;
    const identity = await deps.identityStore.loadOrCreate();
    const hostname = defaultHostname(identity.engineId, config.engineDomain);
    const server = deps.certificates === undefined ? null : startServer(identity.engineId, deps.certificates, deps);
    deps.certificates?.addHostnames([hostname]);
    let handler: StreamHandler | null = server === null ? null : server.handler;
    const defaultHandler = handler;
    logger.info('engine.started', {
        engineId: identity.engineId,
        hostname,
        version: config.engineVersion,
        relays: config.relays.length,
        proxy: config.proxy !== null,
    });

    const links = config.relays.map((relay) => {
        const onStateChange = stateListener(relay, deps);
        return createRelayLink({
            relay,
            identity,
            engineVersion: config.engineVersion,
            offer: deps.offer ?? DEFAULT_TUNNEL_OFFER,
            defaultHostname: hostname,
            dialer: deps.dialer,
            clock: deps.clock,
            random: deps.random,
            logger,
            onStream: (stream) => {
                if (handler === null) {
                    logger.warn('stream.refused', { relay: relay.url, stream: stream.id });
                    stream.close(CLOSE_CODE.REFUSED);
                    return REFUSED_EVENTS;
                }
                const duplex = openTunnelDuplex(stream);
                handler(duplex, relay);
                return duplex.events;
            },
            ...(onStateChange === undefined ? {} : { onStateChange }),
        });
    });
    for (const link of links) link.start();

    return {
        identity,
        hostname,
        links,
        onStream(next) {
            handler = next;
            return () => {
                if (handler === next) handler = defaultHandler;
            };
        },
        async close() {
            await Promise.all(links.map((link) => link.stop()));
            server?.close();
            deps.certificates?.close();
            logger.info('engine.stopped', {});
        },
    };
}

/** Relays confirm extra hostnames (custom domains) in `ready`; the engine needs certificates for those too. */
function stateListener(relay: RelayTarget, deps: MockEngineDeps): ((state: RelayLinkState) => void) | undefined {
    const { certificates, onLinkState } = deps;
    if (certificates === undefined && onLinkState === undefined) return undefined;
    return (state) => {
        if (state.kind === 'ready') certificates?.addHostnames(state.session.hostnames);
        onLinkState?.(relay, state);
    };
}

/** Tunnel streams → TLS (engine key, chosen by SNI) → HTTP app with the spike routes. */
function startServer(
    engineId: EngineIdentity['engineId'],
    certificates: ManagedCertificateSource,
    deps: MockEngineDeps,
): { readonly handler: StreamHandler; close(): void } {
    const http = createHttpApp({
        routes: createSpikeRoutes({ engineId, clock: deps.clock }),
        rateLimiter: createWindowRateLimiter({ clock: deps.clock }),
        logger: deps.logger,
    });
    const tls = createTlsStreamServer({
        certificates,
        logger: deps.logger,
        onSecureConnection: (socket, connection) => {
            http.serve(socket, connection);
        },
    });
    return {
        handler: (stream) => {
            tls.handle(stream, { family: stream.remoteFamily, address: stream.remoteAddress, port: stream.remotePort });
        },
        close() {
            tls.close();
            http.close();
        },
    };
}
