import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Hostname } from '@ptbk/protocol';
import { TUNNEL_FEATURES, TUNNEL_PROTOCOL_VERSIONS } from '@ptbk/protocol';

import { createCachedDnsResolver } from '../domain/cached-dns';
import type { CachedRegistry } from '../domain/cached-registry';
import { createCachedRegistry } from '../domain/cached-registry';
import type { Clock } from '../domain/clock';
import type { DnsResolver } from '../domain/dns-resolver';
import { certificateNameCovers } from '../domain/engine-domain';
import type { EngineRegistry } from '../domain/engine-registry';
import type { MemoryBudget } from '../domain/limits/memory-budget';
import type { Metrics } from '../domain/metrics/catalog';
import { createMemoryBudget } from '../domain/limits/memory-budget';
import type { Logger } from '../domain/logger';
import type { TunnelTerminationReason } from '../domain/metrics/reason-counters';
import { TUNNEL_TERMINATION_REASONS, createReasonCounters } from '../domain/metrics/reason-counters';
import type { Random } from '../domain/random';
import { createRevalidator } from '../domain/tunnel/revalidation';
import type { SessionTable } from '../domain/tunnel/session-table';
import { createSessionTable } from '../domain/tunnel/session-table';
import { createTunnelEndpoint } from '../domain/tunnel/tunnel-endpoint';
import type { TunnelSession } from '../domain/tunnel/tunnel-session';
import { createHttpEngineRegistry } from '../adapters/http-engine-registry';
import { createMetricsEndpoint } from '../adapters/metrics-endpoint';
import { createNodeDnsResolver } from '../adapters/node-dns-resolver';
import { createOwnTlsServer } from '../adapters/own-tls-server';
import type { ProcessStats } from '../adapters/process-stats';
import { createProcessStats } from '../adapters/process-stats';
import type { PrometheusMetrics } from '../adapters/prometheus-metrics';
import { createStaticFileRegistry } from '../adapters/static-file-registry';
import type { BrowserListenerMetrics } from '../adapters/tcp-listener';
import { createBrowserListener } from '../adapters/tcp-listener';
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
    /** Counters the relay records, rendered on `GET /metrics`. */
    readonly metrics: PrometheusMetrics;
}

export interface RelayServices {
    /** Cached, stale-on-error; the only registry the rest of the relay sees. */
    readonly registry: CachedRegistry;
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

export interface RelayListener {
    readonly port: number;
    readonly sessions: SessionTable<TunnelSession>;
    /** Counters of the browser side, for I-04. */
    readonly browser: BrowserListenerMetrics;
    /** Every byte held for others, against `RELAY_MEMORY_BUDGET_BYTES`. */
    readonly memory: Pick<MemoryBudget, 'used' | 'isOver'>;
    /** Tunnels the relay cut on its own, per reason, for I-04. */
    terminations(): Readonly<Record<TunnelTerminationReason, number>>;
    /** What `GET /metrics` answers: every series, with gauges read now. */
    renderMetrics(): string;
    /** One revalidation round now, past the registry cache; never rejects. */
    revalidate(): Promise<void>;
    /** New connections to the relay's own hostname use this certificate; open tunnels stay connected. */
    setCertificate(tls: RelayTls): void;
    /**
     * Stops revalidation and accepting, destroys browser connections, closes every tunnel with `SHUTTING_DOWN`, and
     * waits for the sockets.
     */
    close(): Promise<void>;
}

export interface RelayTls {
    readonly cert: string;
    readonly key: string;
}

/** The relay's own certificate and key could not be read or loaded, or are not the relay's to hold. */
export class RelayTlsError extends Error {
    /** Names settings, never file contents. */
    constructor(
        message = 'RELAY_TLS_CERT_FILE and RELAY_TLS_KEY_FILE must be a readable PEM certificate and its private key',
    ) {
        super(message);
        this.name = 'RelayTlsError';
    }
}

const ENGINE_DOMAIN_CERTIFICATE = 'RELAY_TLS_CERT_FILE must not be valid for RELAY_ENGINE_DOMAIN or any name under it';

async function registrySource(
    config: RelayConfig,
    deps: Pick<RelayDeps, 'logger' | 'clock'>,
): Promise<{ readonly source: EngineRegistry; reload(): Promise<void> }> {
    const { logger, clock } = deps;
    switch (config.registry.kind) {
        case 'http': {
            const { url, token, timeoutMs } = config.registry;
            const source = createHttpEngineRegistry({
                fetch: (input, init) => fetch(input, init),
                clock,
                logger,
                config: { url, token, timeoutMs },
            });
            // Nothing to re-read: every refresh asks the dashboard.
            return { source, reload: () => Promise.resolve() };
        }
        case 'static': {
            const source = await createStaticFileRegistry({ path: config.registry.file, logger });
            return {
                source,
                reload: async () => {
                    await source.reload();
                },
            };
        }
    }
}

/** The registry source `RELAY_REGISTRY_KIND` picks, behind the one cache, and the cached DNS resolver. */
export async function createRelayServices(
    config: RelayConfig,
    deps: Pick<RelayDeps, 'logger' | 'clock'> & { readonly metrics: Metrics },
): Promise<RelayServices> {
    const { logger, clock, metrics } = deps;
    const origin = await registrySource(config, deps);
    const registry = createCachedRegistry({
        inner: origin.source,
        clock,
        logger,
        metrics,
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
    return { registry, dns, reload: () => origin.reload() };
}

const PEM_BEGIN = '-----BEGIN ';

/** A DNS SAN or subject CN value as Node prints it: bare, or JSON-quoted when it holds special characters. */
function unquote(value: string): string {
    return value.startsWith('"') ? String(JSON.parse(value)) : value;
}

/** Every name a TLS client could match the leaf certificate against: its DNS SANs and its subject CN. */
function certificateNames(certificate: X509Certificate): readonly string[] {
    const sans = [...(certificate.subjectAltName ?? '').matchAll(/(?:^|, )DNS:("(?:[^"\\]|\\.)*"|[^,]*)/g)];
    // Node returns undefined for an empty subject, which lego and ACME CAs issue: the names are in the SAN only.
    const subject = certificate.subject as string | undefined;
    const cns = [...(subject ?? '').matchAll(/^CN=(.*)$/gm)];
    return [...sans, ...cns].map((match) => unquote(match[1] as string));
}

/**
 * Rule 1 in configuration: the relay refuses to hold a certificate that could make it a TLS endpoint for an engine,
 * whatever the file contains.
 */
export function assertRelayCertificate(cert: string, engineDomain: Hostname): void {
    let certificate: X509Certificate;
    try {
        certificate = new X509Certificate(cert);
    } catch {
        throw new RelayTlsError();
    }
    if (certificateNames(certificate).some((name) => certificateNameCovers(name, engineDomain))) {
        throw new RelayTlsError(ENGINE_DOMAIN_CERTIFICATE);
    }
}

/** When the leaf certificate expires, in Unix seconds; the PEM was checked when it was read. */
export function certificateExpirySeconds(cert: string): number {
    return Math.floor(new X509Certificate(cert).validToDate.getTime() / 1000);
}

/** Reads and checks the relay's own certificate and key; throws {@link RelayTlsError}. */
export async function readRelayTls(config: RelayConfig): Promise<RelayTls> {
    const [cert, key] = await Promise.all([
        readFile(config.tls.certFile, 'utf8'),
        readFile(config.tls.keyFile, 'utf8'),
    ]).catch(() => {
        throw new RelayTlsError();
    });
    // Node treats an empty key as no key at all and would start a listener that fails every handshake.
    if (!cert.includes(PEM_BEGIN) || !key.includes(PEM_BEGIN)) throw new RelayTlsError();
    assertRelayCertificate(cert, config.engineDomain);
    return { cert, key };
}

/**
 * The listener on `RELAY_LISTEN_PORT`: the SNI dispatcher in front of the tunnel endpoint's TLS server, the session
 * table and revalidation. Takes the services so integration tests can run it on an in-memory registry and resolver.
 */
export async function startRelayListener(
    config: RelayConfig,
    services: Pick<RelayServices, 'registry' | 'dns'>,
    tls: RelayTls,
    deps: RelayDeps,
): Promise<RelayListener> {
    const { logger, clock, livenessClock, random, metrics } = deps;
    const { registry, dns } = services;
    const table = createSessionTable<TunnelSession>({ logger });
    const memory = createMemoryBudget(config.memoryBudgetBytes);
    const terminations = createReasonCounters(TUNNEL_TERMINATION_REASONS);
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
            registryMissesPerS: config.tunnel.registryMissesPerS,
            session: {
                framesPerS: config.tunnel.framesPerS,
                minWindowIncrementBytes: config.tunnel.minWindowIncrementBytes,
            },
        },
        table,
        terminations,
        metrics,
    });
    const processStats = createProcessStats();
    let certificateExpiresAtS = certificateExpirySeconds(tls.cert);
    // Assigned below; scrapes arrive only once the listener accepts connections.
    let collect = (): void => undefined;
    const renderMetrics = (): string => {
        collect();
        return metrics.render();
    };
    const server = (() => {
        try {
            return createOwnTlsServer({
                ...tls,
                endpoint,
                tunnel: {
                    clock: livenessClock,
                    random,
                    logger,
                    limits: {
                        pingBufferBytes: config.tunnel.pingBufferBytes,
                        maxBufferedBytes: config.tunnel.maxBufferedBytes,
                    },
                    memory,
                    terminations,
                },
                clock: livenessClock,
                logger,
                maxConnections: config.browser.maxConnections,
                metrics:
                    config.metrics === null
                        ? null
                        : createMetricsEndpoint({ token: config.metrics.token, render: renderMetrics }),
            });
        } catch {
            throw new RelayTlsError();
        }
    })();
    const browser = createBrowserListener({
        relayId: config.relayId,
        engineDomain: config.engineDomain,
        sessions: table,
        own: server,
        limits: config.browser,
        clock,
        logger,
        memory,
        metrics,
    });
    collect = () => {
        collectGauges(metrics, {
            tunnels: table.sessions().length,
            browser,
            memoryUsed: memory.used(),
            terminations: terminations.snapshot(),
            process: processStats,
            certificateExpiresAtS,
        });
    };
    const port = await browser
        .listen(config.listen.port, config.listen.host, config.listen.backlog)
        .catch((error: unknown) => {
            processStats.stop();
            throw error;
        });
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
        browser,
        memory,
        terminations: () => terminations.snapshot(),
        renderMetrics,
        revalidate: () => revalidator.runOnce(),
        setCertificate(next) {
            server.setCertificate(next.cert, next.key);
            certificateExpiresAtS = certificateExpirySeconds(next.cert);
        },
        async close() {
            revalidator.stop();
            processStats.stop();
            // The TCP server waits for every connection, the tunnels too, so both close together.
            await Promise.all([browser.close(), server.close()]);
        },
    };
}

interface GaugeSources {
    readonly tunnels: number;
    readonly browser: BrowserListenerMetrics;
    readonly memoryUsed: number;
    readonly terminations: Readonly<Record<TunnelTerminationReason, number>>;
    readonly process: ProcessStats;
    readonly certificateExpiresAtS: number;
}

const entriesOf = <K extends string>(record: Readonly<Record<K, number>>): readonly (readonly [K, number])[] =>
    Object.entries(record) as [K, number][];

/** Reads every gauge, and the counters other parts keep per reason, into `metrics` just before a scrape. */
function collectGauges(metrics: PrometheusMetrics, sources: GaugeSources): void {
    const { browser, process } = sources;
    metrics.set('ptbk_relay_tunnels_active', {}, sources.tunnels);
    metrics.set('ptbk_relay_browser_connections_active', {}, browser.connections());
    metrics.set('ptbk_relay_browser_connections_pending', {}, browser.pendingConnections());
    for (const [reason, count] of entriesOf(browser.refusals())) {
        metrics.set('ptbk_relay_browser_refusals_total', { reason }, count);
    }
    for (const [reason, count] of entriesOf(browser.resets())) {
        metrics.set('ptbk_relay_stream_resets_total', { reason }, count);
    }
    for (const [reason, count] of entriesOf(sources.terminations)) {
        metrics.set('ptbk_relay_tunnel_terminations_total', { reason }, count);
    }
    metrics.set('ptbk_relay_memory_budget_used_bytes', {}, sources.memoryUsed);
    metrics.set('ptbk_relay_process_resident_memory_bytes', {}, process.residentMemoryBytes());
    metrics.set('ptbk_relay_process_heap_used_bytes', {}, process.heapUsedBytes());
    const fds = process.openFds();
    if (fds !== null) metrics.set('ptbk_relay_process_open_fds', {}, fds);
    metrics.set('ptbk_relay_event_loop_lag_seconds', {}, process.takeEventLoopLagSeconds());
    metrics.set('ptbk_relay_process_start_time_seconds', {}, process.startTimeSeconds);
    metrics.set('ptbk_relay_certificate_expiry_timestamp_seconds', {}, sources.certificateExpiresAtS);
}

/** The composition root. Resolves once the relay listens; `close` stops it and releases everything it holds. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/**
 * SIGHUP: re-reads the registry source, expires the registry cache, loads the relay certificate again (keeping the
 * old one if the new files are unusable) and runs a revalidation round, so registry changes take effect at once.
 */
async function hangUp(
    config: RelayConfig,
    services: RelayServices,
    listener: RelayListener,
    logger: Logger,
): Promise<void> {
    await services.reload();
    services.registry.expireAll();
    try {
        listener.setCertificate(await readRelayTls(config));
        logger.info('relay.certificate-loaded', {});
    } catch (error) {
        logger.error('relay.certificate-rejected', {
            problem: error instanceof RelayTlsError ? error.message : errorName(error),
        });
    }
    await listener.revalidate();
}

export async function startRelay(config: RelayConfig, deps: RelayDeps): Promise<Relay> {
    const { logger } = deps;
    const services = await createRelayServices(config, deps);
    const listener = await startRelayListener(config, services, await readRelayTls(config), deps);
    const onHangup = (): void => {
        hangUp(config, services, listener, logger).catch((error: unknown) => {
            logger.error('relay.reload-failed', { problem: errorName(error) });
        });
    };
    process.on('SIGHUP', onHangup);
    logger.info('relay.started', { relayId: config.relayId, registry: config.registry.kind, port: listener.port });
    let closing: Promise<void> | null = null;
    return {
        port: listener.port,
        close() {
            closing ??= (async () => {
                process.off('SIGHUP', onHangup);
                await listener.close();
                logger.info('relay.stopped', {});
            })();
            return closing;
        },
    };
}
