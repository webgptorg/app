import type { Bytes, RelayId } from '@ptbk/protocol';

import type { CheckContext, CheckOutcome } from '../../../src/check';
import { fail, skip } from '../../../src/check';
import type { SessionCredential } from '../../../src/target';
import { TIMED_OUT } from '../../fake-relay/event-queue';
import type { ConnectionEvent, RelayConnection } from '../../fake-relay/fake-relay';
import type { RelayTunnel } from '../../fake-relay/relay-tunnel';
import type { TunnelRuntime } from '../runtime';
import type { EngineTls } from '../through-stream';
import { connectThroughTunnel, engineHostname } from '../through-stream';

export interface TunnelCheckContext {
    readonly runtime: TunnelRuntime;
    readonly check: CheckContext;
    readonly signal: AbortSignal;
}

export type TunnelCheckRun = (ctx: TunnelCheckContext) => Promise<CheckOutcome>;

export function engineKey(ctx: TunnelCheckContext): Bytes {
    const key = ctx.runtime.engine.enginePublicKey;
    if (key === null) skip('the harness does not know the engine public key');
    return key;
}

export function needsRelays(ctx: TunnelCheckContext, count: number): void {
    if (ctx.runtime.relayIds.length < count) skip(`needs at least ${String(count)} relays in the engine's list`);
}

export async function readyTunnel(
    ctx: TunnelCheckContext,
    relayId: RelayId = ctx.runtime.primary,
): Promise<RelayTunnel> {
    const tunnel = await ctx.runtime.waitReady(relayId, ctx.runtime.timing.reconnectMs, ctx.signal);
    if (tunnel === null) fail(`no ready tunnel to ${relayId} within ${String(ctx.runtime.timing.reconnectMs)} ms`);
    return tunnel;
}

/** The engine's next connection to a relay in manual mode, or a failure naming what was waited for. */
export async function nextConnection(
    next: (timeoutMs: number) => Promise<RelayConnection | null>,
    timeoutMs: number,
    waitingFor: string,
): Promise<RelayConnection> {
    const connection = await next(timeoutMs);
    if (connection === null) fail(`the engine did not connect ${waitingFor} within ${String(timeoutMs)} ms`);
    return connection;
}

export type CloseWait = { readonly kind: 'closed'; readonly code: number } | { readonly kind: 'open' };

/** Whether the engine closes `connection` within `timeoutMs`; with the close code it used. */
export async function closeWithin(connection: RelayConnection, timeoutMs: number): Promise<CloseWait> {
    const closed = await Promise.race([
        connection.closed,
        new Promise<null>((resolve) => setTimeout(resolve, timeoutMs, null)),
    ]);
    return closed === null ? { kind: 'open' } : { kind: 'closed', code: closed.code };
}

/** Collects what the engine sends on a manual connection for `ms`, stopping early when it closes. */
export async function collect(
    connection: RelayConnection,
    ms: number,
    signal: AbortSignal,
): Promise<ConnectionEvent[]> {
    const deadline = performance.now() + ms;
    const events: ConnectionEvent[] = [];
    for (;;) {
        const left = deadline - performance.now();
        if (left <= 0) return events;
        const event = await connection.events.next(left, signal);
        if (event === TIMED_OUT) return events;
        events.push(event);
        if (event.kind === 'closed') return events;
    }
}

export async function ownerSession(ctx: TunnelCheckContext): Promise<SessionCredential | null> {
    try {
        return await ctx.check.target.session({ kind: 'owner' });
    } catch {
        return null;
    }
}

/** TLS through a new stream of `tunnel` to the engine's default hostname. */
export function tlsToEngine(
    ctx: TunnelCheckContext,
    tunnel: RelayTunnel,
    options: Partial<Parameters<typeof connectThroughTunnel>[1]> = {},
): Promise<EngineTls> {
    return connectThroughTunnel(tunnel, {
        servername: engineHostname(tunnel, ctx.runtime.engine.engineDomain),
        certificateAuthorityPem: ctx.runtime.engine.certificateAuthorityPem ?? null,
        timeoutMs: ctx.runtime.timing.requestMs,
        ...options,
    });
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** The engine must have survived what the suite did to it, when the harness can tell. */
export function engineAlive(ctx: TunnelCheckContext): string | null {
    return ctx.runtime.engine.running?.() === false ? 'the engine process exited' : null;
}
