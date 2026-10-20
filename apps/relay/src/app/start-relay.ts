import { readFile } from 'node:fs/promises';

import { TUNNEL_FEATURES, TUNNEL_PROTOCOL_VERSIONS } from '@ptbk/protocol';

import { createCachedDnsResolver } from '../domain/cached-dns';
import { createCachedRegistry } from '../domain/cached-registry';
import type { Clock } from '../domain/clock';
import type { DnsResolver } from '../domain/dns-resolver';
import type { EngineRegistry } from '../domain/engine-registry';
import type { Logger } from '../domain/logger';
import type { Random } from '../domain/random';
import { createRevalidator } from '../domain/tunnel/revalidation';
import type { SessionTable } from '../domain/tunnel/session-table';
import { createSessionTable } from '../domain/tunnel/session-table';
import { createTunnelEndpoint } from '../domain/tunnel/tunnel-endpoint';
import type { TunnelSession } from '../domain/tunnel/tunnel-session';
import { createNodeDnsResolver } from '../adapters/node-dns-resolver';
import { createOwnTlsServer } from '../adapters/own-tls-server';
import { createStaticFileRegistry } from '../adapters/static-file-registry';
import type { RelayConfig } from './config';

/** Long enough that a newly registered engine is not refused for a whole registry TTL. */
export const REGISTRY_NEGATIVE_TTL_MS = 30_000;

export interface RelayDeps {
    readonly logger: Logger;
    /** Handshake deadlines, registry and DNS caching, revalidation. */
    readonly clock: Clock;
    /** WebSocket pings and the shutdown grace period: real time, even when a test drives `clock`. */
    readonly livenessClock: Clock;
    /** Challenge nonces. */
    readonly random: Random;
}

export interface RelayServices {
    /** Cached, stale-on-error; the only registry the rest of the relay sees. */
    readonly registry: EngineRegistry;
    /** Cached at the registry's pace, for `routableHostnames`. */
    readonly dns: DnsResolver;
    /** Re-reads the registry source where it can (the static file on SIGHUP). */
    reload(): Promise<void>;
}

export interface Relay {
    /** The bound port (`RELAY_LISTEN_PORT=0` picks one). */
    readonly port: number;
    close(): Promise<void>;
}

export interface TunnelListener {
    readonly port: number;
    readonly sessions: SessionTable<TunnelSession>;
    /** Stops revalidation and accepting, closes every tunnel with `SHUTTING_DOWN`, and waits for the sockets. */
    close(): Promise<void>;
}

/** The relay's own certificate and key could not be read or loaded; names the setting, never file contents. */
export class RelayTlsError extends Error {
    constructor() {
        super('RELAY_TLS_CERT_FILE and RELAY_TLS_KEY_FILE must be a readable PEM certificate and its private key');
        this.name = 'RelayTlsError';
    }
}

export class UnsupportedRegistryError extends Error {
    constructor() {
        super('RELAY_REGISTRY_KIND=http needs the HTTP registry adapter, which is not built yet (D-04); use static');
        this.name = 'UnsupportedRegistryError';
    }
}

export async function createRelayServices(
    config: RelayConfig,
    deps: Pick<RelayDeps, 'logger' | 'clock'>,
): Promise<RelayServices> {
    const { logger, clock } = deps;
    switch (config.registry.kind) {
        case 'http':
            throw new UnsupportedRegistryError();
        case 'static': {
            const source = await createStaticFileRegistry({ path: config.registry.file, logger });
            const registry = createCachedRegistry({
                inner: source,
                clock,
                logger,
                ttlMs: config.registry.ttlMs,
                maxStaleMs: config.registry.maxStaleMs,
                negativeTtlMs: REGISTRY_NEGATIVE_TTL_MS,
                lookupTimeoutMs: config.registry.timeoutMs,
            });
            const dns = createCachedDnsResolver({
                inner: createNodeDnsResolver(config.dns),
                clock,
                logger,
                ttlMs: config.registry.ttlMs,
                maxStaleMs: config.registry.maxStaleMs,
                timeoutMs: config.dns.timeoutMs,
            });
            return {
                registry,
                dns,
                reload: async () => {
                    await source.reload();
                },
            };
        }
    }
}

const PEM_BEGIN = '-----BEGIN ';

async function readRelayTls(config: RelayConfig): Promise<{ readonly cert: string; readonly key: string }> {
    const [cert, key] = await Promise.all([
        readFile(config.tls.certFile, 'utf8'),
        readFile(config.tls.keyFile, 'utf8'),
    ]).catch(() => {
        throw new RelayTlsError();
    });
    // Node treats an empty key as no key at all and would start a listener that fails every handshake.
    if (!cert.includes(PEM_BEGIN) || !key.includes(PEM_BEGIN)) throw new RelayTlsError();
    return { cert, key };
}

/**
 * The tunnel endpoint on `RELAY_LISTEN_PORT`, its session table and revalidation. Takes the services so integration
 * tests can run it on an in-memory registry and resolver. R-04 puts an SNI dispatcher in front of it on port 443.
 */
export async function startTunnelListener(
    config: RelayConfig,
    services: Pick<RelayServices, 'registry' | 'dns'>,
    tls: { readonly cert: string; readonly key: string },
    deps: RelayDeps,
): Promise<TunnelListener> {
    const { logger, clock, livenessClock, random } = deps;
    const { registry, dns } = services;
    const table = createSessionTable<TunnelSession>({ logger });
    const endpoint = createTunnelEndpoint({
        relayId: config.relayId,
        engineDomain: config.engineDomain,
        offer: { versions: TUNNEL_PROTOCOL_VERSIONS, features: TUNNEL_FEATURES },
        registry,
        dns,
        random,
        clock,
        logger,
        limits: {
            handshakeTimeoutMs: config.tunnel.handshakeTimeoutMs,
            maxPending: config.tunnel.maxPendingHandshakes,
            maxPendingPerIp: config.tunnel.maxPendingHandshakesPerIp,
            maxTunnelsPerIp: config.tunnel.maxTunnelsPerIp,
        },
        table,
    });
    const server = (() => {
        try {
            return createOwnTlsServer({ ...tls, endpoint, liveness: { clock: livenessClock }, clock: livenessClock });
        } catch {
            throw new RelayTlsError();
        }
    })();
    const port = await server.listen(config.listen.port, config.listen.host);
    const revalidator = createRevalidator({
        clock,
        intervalMs: config.registry.ttlMs,
        table,
        registry,
        dns,
        engineDomain: config.engineDomain,
        logger,
    });
    revalidator.start();
    return {
        port,
        sessions: table,
        async close() {
            revalidator.stop();
            await server.close();
        },
    };
}

/** The composition root. Resolves once the relay listens; `close` stops it and releases everything it holds. */
export async function startRelay(config: RelayConfig, deps: RelayDeps): Promise<Relay> {
    const { logger } = deps;
    const services = await createRelayServices(config, deps);
    const tunnels = await startTunnelListener(config, services, await readRelayTls(config), deps);
    const onHangup = (): void => {
        void services.reload();
    };
    process.on('SIGHUP', onHangup);
    logger.info('relay.started', { relayId: config.relayId, registry: config.registry.kind, port: tunnels.port });
    let closing: Promise<void> | null = null;
    return {
        port: tunnels.port,
        close() {
            closing ??= (async () => {
                process.off('SIGHUP', onHangup);
                await tunnels.close();
                logger.info('relay.stopped', {});
            })();
            return closing;
        },
    };
}
