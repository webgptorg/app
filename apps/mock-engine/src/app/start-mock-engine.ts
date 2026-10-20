import type { Hostname } from '@ptbk/protocol';
import { CLOSE_CODE, TUNNEL_FEATURES, TUNNEL_PROTOCOL_VERSIONS, TunnelFeature, defaultHostname } from '@ptbk/protocol';

import type { TunnelDuplex } from '../adapters/tunnel-duplex';
import { openTunnelDuplex } from '../adapters/tunnel-duplex';
import type { Clock } from '../domain/clock';
import type { EngineIdentity, IdentityStore } from '../domain/identity/engine-identity';
import type { Logger } from '../domain/logger';
import type { Random } from '../domain/random';
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
}

/** A browser connection through `relay`; the TLS server inside the tunnel (M-02) takes it from here. */
export type StreamHandler = (stream: TunnelDuplex, relay: RelayTarget) => void;

export interface MockEngine {
    readonly identity: EngineIdentity;
    /** `<engineId>.<engine domain>`. */
    readonly hostname: Hostname;
    /** One per configured relay, each independent of the others. */
    readonly links: readonly RelayLink[];
    /** Sets the one stream handler; returns a function that removes it. Without a handler streams are refused. */
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
    let handler: StreamHandler | null = null;
    logger.info('engine.started', {
        engineId: identity.engineId,
        hostname,
        version: config.engineVersion,
        relays: config.relays.length,
        proxy: config.proxy !== null,
    });

    const links = config.relays.map((relay) => {
        const onLinkState = deps.onLinkState;
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
            ...(onLinkState === undefined
                ? {}
                : {
                      onStateChange: (state: RelayLinkState) => {
                          onLinkState(relay, state);
                      },
                  }),
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
                if (handler === next) handler = null;
            };
        },
        async close() {
            await Promise.all(links.map((link) => link.stop()));
            logger.info('engine.stopped', {});
        },
    };
}
