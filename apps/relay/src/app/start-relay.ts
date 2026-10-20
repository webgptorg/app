import { createCachedDnsResolver } from '../domain/cached-dns';
import { createCachedRegistry } from '../domain/cached-registry';
import type { Clock } from '../domain/clock';
import type { DnsResolver } from '../domain/dns-resolver';
import type { EngineRegistry } from '../domain/engine-registry';
import type { Logger } from '../domain/logger';
import { createNodeDnsResolver } from '../adapters/node-dns-resolver';
import { createStaticFileRegistry } from '../adapters/static-file-registry';
import type { RelayConfig } from './config';

/** Long enough that a newly registered engine is not refused for a whole registry TTL. */
export const REGISTRY_NEGATIVE_TTL_MS = 30_000;

export interface RelayDeps {
    readonly logger: Logger;
    readonly clock: Clock;
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
    close(): Promise<void>;
}

export class UnsupportedRegistryError extends Error {
    constructor() {
        super('RELAY_REGISTRY_KIND=http needs the HTTP registry adapter, which is not built yet (D-04); use static');
        this.name = 'UnsupportedRegistryError';
    }
}

export async function createRelayServices(config: RelayConfig, deps: RelayDeps): Promise<RelayServices> {
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

/** The composition root. Resolves once the relay runs; `close` stops it and releases everything it holds. */
export async function startRelay(config: RelayConfig, deps: RelayDeps): Promise<Relay> {
    const { logger } = deps;
    // R-03 and R-04 hand these services to their listeners.
    const services = await createRelayServices(config, deps);
    const onHangup = (): void => {
        void services.reload();
    };
    process.on('SIGHUP', onHangup);
    // Until R-03's listener holds the event loop, this keeps the process up between signals.
    const keepAlive = setInterval(() => undefined, 2 ** 31 - 1);
    logger.info('relay.started', { relayId: config.relayId, registry: config.registry.kind });
    let closed = false;
    return {
        close() {
            if (!closed) {
                closed = true;
                process.off('SIGHUP', onHangup);
                clearInterval(keepAlive);
                logger.info('relay.stopped', {});
            }
            return Promise.resolve();
        },
    };
}
