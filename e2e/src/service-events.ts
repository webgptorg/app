// The relays and the mock engine log one JSON object per line with an ISO `time` and an `event` name. Network tests
// time and check behaviour from those events rather than from sleeps or wall-clock guesses.
import type { ComposeControl } from './compose.ts';
import type { TcpAttempt, TcpOutcome } from './tcp-check.ts';

export interface ServiceEvent {
    readonly timeMs: number;
    readonly event: string;
    readonly fields: Readonly<Record<string, unknown>>;
}

/** Lines that are not such an object (another tool's output, a stack trace) are skipped. */
export function parseServiceEvents(log: string): readonly ServiceEvent[] {
    return log.split('\n').flatMap((line) => {
        if (!line.startsWith('{')) return [];
        try {
            const fields = JSON.parse(line) as Record<string, unknown>;
            const timeMs = typeof fields['time'] === 'string' ? Date.parse(fields['time']) : Number.NaN;
            const event = fields['event'];
            return Number.isFinite(timeMs) && typeof event === 'string' ? [{ timeMs, event, fields }] : [];
        } catch {
            return [];
        }
    });
}

export async function serviceEvents(compose: ComposeControl, service: string): Promise<readonly ServiceEvent[]> {
    return parseServiceEvents(await compose.logs(service));
}

/** Events named `event` at or after `sinceMs` whose fields include every entry of `match`. */
export function eventsAfter(
    events: readonly ServiceEvent[],
    event: string,
    sinceMs: number,
    match: Readonly<Record<string, unknown>> = {},
): readonly ServiceEvent[] {
    return events.filter(
        (candidate) =>
            candidate.event === event &&
            candidate.timeMs >= sinceMs &&
            Object.entries(match).every(([key, value]) => candidate.fields[key] === value),
    );
}

const OUTCOMES: ReadonlySet<string> = new Set(['connected', 'refused', 'timeout', 'unreachable', 'error']);

export function parseTcpAttempt(output: string): TcpAttempt {
    const parsed = JSON.parse(output.trim()) as { outcome?: unknown; banner?: unknown; elapsedMs?: unknown };
    if (typeof parsed.outcome !== 'string' || !OUTCOMES.has(parsed.outcome)) throw new Error('not a tcp-check result');
    return {
        outcome: parsed.outcome as TcpOutcome,
        banner: typeof parsed.banner === 'string' ? parsed.banner : '',
        elapsedMs: typeof parsed.elapsedMs === 'number' ? parsed.elapsedMs : 0,
    };
}

/**
 * A TCP attempt made from inside another container's network namespace (the engine host, the gateway), as nobody, so
 * the exec has none of the container's capabilities.
 */
export async function tcpAttemptFrom(
    compose: ComposeControl,
    service: string,
    target: { readonly host: string; readonly port: number },
    timeoutMs: number,
): Promise<TcpAttempt> {
    const result = await compose.exec(
        service,
        ['node', '/e2e/tcp-check.ts', 'connect', target.host, String(target.port), '--timeout-ms', String(timeoutMs)],
        { user: '65534:65534' },
    );
    if (result.exitCode !== 0) throw new Error(`tcp-check in ${service} exited with ${String(result.exitCode)}`);
    return parseTcpAttempt(result.stdout);
}
