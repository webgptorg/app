import type { EngineId } from '@ptbk/protocol';
import { REGISTRY_ENTRY_MAX_BYTES, TolerantRegistryEntry, registryPath } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { EngineRegistry, RegistryLookup } from '../domain/engine-registry';
import type { Logger } from '../domain/logger';

/** What a failed lookup is logged as; never a status line, header, body or token. */
export type RegistryFailure =
    'timeout' | 'network' | 'server-error' | 'unauthorized' | 'unexpected-status' | 'invalid-body';

export type RegistryFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpEngineRegistryOptions {
    readonly fetch: RegistryFetch;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly config: {
        /** `RELAY_REGISTRY_URL`: the dashboard's base URL. */
        readonly url: string;
        /** `RELAY_REGISTRY_TOKEN`; revealed only into the request header. */
        readonly token: { reveal(): string };
        readonly timeoutMs: number;
    };
}

class TooLarge extends Error {}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (reader === undefined) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new TooLarge();
        }
        chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function failureFor(status: number): RegistryFailure {
    if (status === 401 || status === 403) return 'unauthorized';
    return status >= 500 ? 'server-error' : 'unexpected-status';
}

/**
 * D-04's dashboard registry (C-03 Interface 2): one GET per lookup with the relay key, read tolerantly (rule 5: known
 * fields validated, unknown ones stripped). Holds no cache and verifies no claims: `createCachedRegistry` wraps it, and
 * `routableHostnames` checks every hostname it returns.
 */
export function createHttpEngineRegistry(options: HttpEngineRegistryOptions): EngineRegistry {
    const { fetch, clock, logger, config } = options;
    const base = config.url.replace(/\/+$/, '');

    async function request(engineId: EngineId, signal: AbortSignal): Promise<RegistryLookup | RegistryFailure> {
        const response = await fetch(base + registryPath(engineId), {
            method: 'GET',
            headers: { Authorization: `Bearer ${config.token.reveal()}`, Accept: 'application/json' },
            // A redirect would carry the key somewhere RELAY_REGISTRY_URL does not name.
            redirect: 'error',
            signal,
        });
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            return response.status === 404 ? { kind: 'not-found' } : failureFor(response.status);
        }
        let bytes: Uint8Array;
        try {
            bytes = await readCapped(response, REGISTRY_ENTRY_MAX_BYTES);
        } catch (error) {
            if (error instanceof TooLarge) return 'invalid-body';
            throw error;
        }
        let json: unknown;
        try {
            json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
            return 'invalid-body';
        }
        const entry = TolerantRegistryEntry.safeParse(json);
        return entry.success ? { kind: 'found', entry: entry.data } : 'invalid-body';
    }

    return {
        async lookup(engineId, signal) {
            if (signal.aborted) throw signal.reason as Error;
            const controller = new AbortController();
            // Read through these after the await: the abort and the timer change them meanwhile.
            const callerAborted = (): boolean => signal.aborted;
            const state = { timedOut: false };
            const cancel = clock.setTimeout(() => {
                state.timedOut = true;
                controller.abort(new DOMException('timed out', 'TimeoutError'));
            }, config.timeoutMs);
            const onAbort = (): void => {
                controller.abort(signal.reason);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            let outcome: RegistryLookup | RegistryFailure;
            try {
                outcome = await request(engineId, controller.signal);
            } catch {
                if (callerAborted()) throw signal.reason as Error;
                outcome = state.timedOut ? 'timeout' : 'network';
            } finally {
                cancel();
                signal.removeEventListener('abort', onAbort);
            }
            if (typeof outcome !== 'string') return outcome;
            logger.error('registry.error', { engineId, kind: outcome });
            return { kind: 'unavailable' };
        },
    };
}
