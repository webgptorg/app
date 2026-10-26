import type { Clock } from '../domain/clock';
import type { PresenceSink } from '../domain/presence/presence-reporter';
import type { RegistryFetch } from './http-engine-registry';

/** R-07's endpoint on the dashboard; the relay ID comes from the key, never from the body. */
export const PRESENCE_PATH = '/internal/v1/relays/presence';

export interface HttpPresenceSinkOptions {
    readonly fetch: RegistryFetch;
    readonly clock: Clock;
    readonly config: {
        /** `RELAY_REGISTRY_URL`: the dashboard's base URL. */
        readonly url: string;
        /** `RELAY_REGISTRY_TOKEN`: the registry's relay key, revealed only into the request header. */
        readonly token: { reveal(): string };
        readonly timeoutMs: number;
    };
}

/** One `PUT` per report with the relay key; 204 is the only success, and nothing of the answer is read. */
export function createHttpPresenceSink(options: HttpPresenceSinkOptions): PresenceSink {
    const { fetch, clock, config } = options;
    const url = config.url.replace(/\/+$/, '') + PRESENCE_PATH;

    return {
        async report(engineIds, signal) {
            const controller = new AbortController();
            const state = { timedOut: false };
            const cancel = clock.setTimeout(() => {
                state.timedOut = true;
                controller.abort(new DOMException('timed out', 'TimeoutError'));
            }, config.timeoutMs);
            const onAbort = (): void => {
                controller.abort(signal.reason);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                const response = await fetch(url, {
                    method: 'PUT',
                    headers: {
                        Authorization: `Bearer ${config.token.reveal()}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ v: 1, engineIds }),
                    // A redirect would carry the key somewhere RELAY_REGISTRY_URL does not name.
                    redirect: 'error',
                    signal: controller.signal,
                });
                await response.body?.cancel().catch(() => undefined);
                return response.status === 204 ? { kind: 'accepted' } : { kind: 'failed', status: response.status };
            } catch {
                return { kind: 'failed', status: state.timedOut ? 'timeout' : 'network' };
            } finally {
                cancel();
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}
