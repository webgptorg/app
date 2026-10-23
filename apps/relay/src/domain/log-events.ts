/**
 * Every event the relay logs, with the only fields it may carry (spec, Metadata we still see; I-04). Engine IPs appear
 * only on tunnel events (kept 7 days by journald); a browser's address, a ClientHello's SNI and the hostnames of
 * browser connections are never a field. A new event or field is added here first, where review sees it.
 */
export const LOG_EVENTS = {
    'relay.started': ['relayId', 'registry', 'port'],
    'relay.stopping': ['signal'],
    'relay.stopped': [],
    'relay.start-failed': ['problem'],
    'relay.crashed': ['problem'],
    'relay.close-failed': ['problem'],
    'relay.shutdown-timeout': ['timeoutMs'],
    'relay.reload-failed': ['problem'],
    'relay.accept-failed': ['problem'],
    'relay.certificate-loaded': [],
    'relay.certificate-rejected': ['problem'],
    'registry.loaded': ['engines'],
    'registry.reload-failed': ['reason'],
    'registry.error': ['engineId', 'kind'],
    'registry.stale': ['engineId', 'reason', 'ageS'],
    'registry.unavailable': ['engineId', 'reason'],
    'dns.stale': ['reason', 'ageS'],
    'hostname.claim-invalid': ['engineId', 'dropped'],
    'hostname.dns-mismatch': ['engineId', 'dropped'],
    'hostname.conflict': ['engineId', 'otherEngineId'],
    'tunnel.connected': ['engineId', 'engineIp', 'relayId'],
    'tunnel.disconnected': ['engineId', 'engineIp', 'relayId', 'closeCode'],
    'tunnel.rejected': ['engineId', 'engineIp', 'relayId', 'reason', 'closeCode'],
    'tunnel.revoked': ['engineId', 'reason'],
    'tunnel.terminated': ['reason'],
    'tunnel.failed': ['problem'],
    'browser.failed': ['problem'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type LogEvent = keyof typeof LOG_EVENTS;
export type LogFieldName<E extends LogEvent> = (typeof LOG_EVENTS)[E][number];

/** Whether `field` may be logged with `event`. */
export function isAllowedLogField(event: string, field: string): boolean {
    const allowed: readonly string[] | undefined = (LOG_EVENTS as Readonly<Record<string, readonly string[]>>)[event];
    return allowed?.includes(field) === true;
}
