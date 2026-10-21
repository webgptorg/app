import type { Bytes } from '@ptbk/protocol';
import {
    HEARTBEAT_SIGNATURE_HEADER,
    PROBLEM_DETAILS_MAX_BYTES,
    REGISTER_PATH,
    REGISTER_RESPONSE_MAX_BYTES,
    TolerantProblemDetails,
    TolerantRegisterEngineResponse,
    heartbeatPath,
} from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { DashboardApi, DashboardProblem } from '../domain/dashboard/dashboard-api';

export const DEFAULT_DASHBOARD_TIMEOUT_MS = 10_000;

export interface FetchDashboardApiOptions {
    /** `PTBK_DASHBOARD_URL`, an `https://` origin. */
    readonly baseUrl: string;
    readonly fetch: typeof fetch;
    readonly clock: Clock;
    /** Bounds each request, answer included. */
    readonly timeoutMs?: number;
}

const ACCEPT = 'application/json, application/problem+json';

/** The body, or null if it is longer than `maxBytes`; reading stops at the cap. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
    if (response.body === null) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function parseJson(body: Uint8Array | null): unknown {
    if (body === null) return undefined;
    try {
        return JSON.parse(utf8.decode(body));
    } catch {
        return undefined;
    }
}

/** Read tolerantly (rule 5): known members validated, unknown ones stripped. */
async function readProblem(response: Response): Promise<DashboardProblem | null> {
    const parsed = TolerantProblemDetails.safeParse(parseJson(await readBounded(response, PROBLEM_DETAILS_MAX_BYTES)));
    return parsed.success ? { code: parsed.data.code, serverTime: parsed.data.serverTime ?? null } : null;
}

/**
 * The dashboard over HTTP with an injected `fetch` (the proxy-aware HTTPS one in production). Responses are read
 * tolerantly and within the contract's size caps; a timeout, a network failure or an error status without a
 * readable problem is `unavailable`. Nothing is logged here: callers log status codes only.
 */
export function createFetchDashboardApi(options: FetchDashboardApiOptions): DashboardApi {
    const timeoutMs = options.timeoutMs ?? DEFAULT_DASHBOARD_TIMEOUT_MS;

    async function send<T>(
        path: string,
        init: { readonly headers: Record<string, string>; readonly body: Bytes | string },
        signal: AbortSignal,
        read: (response: Response) => Promise<T>,
    ): Promise<T | null> {
        const timeout = new AbortController();
        const cancel = options.clock.setTimeout(() => {
            timeout.abort(new DOMException('dashboard request timed out', 'TimeoutError'));
        }, timeoutMs);
        try {
            const response = await options.fetch(new URL(path, options.baseUrl), {
                method: 'POST',
                headers: { accept: ACCEPT, 'content-type': 'application/json', ...init.headers },
                body: init.body,
                redirect: 'manual',
                signal: AbortSignal.any([signal, timeout.signal]),
            });
            return await read(response);
        } catch {
            return null;
        } finally {
            cancel();
        }
    }

    return {
        async register(request, signal) {
            const call = await send(
                REGISTER_PATH,
                { headers: {}, body: JSON.stringify(request) },
                signal,
                async (response) => {
                    if (response.ok) {
                        const parsed = TolerantRegisterEngineResponse.safeParse(
                            parseJson(await readBounded(response, REGISTER_RESPONSE_MAX_BYTES)),
                        );
                        return parsed.success
                            ? ({ kind: 'ok', response: parsed.data } as const)
                            : ({ kind: 'invalid-response', status: response.status } as const);
                    }
                    const problem = await readProblem(response);
                    return problem === null
                        ? ({ kind: 'unavailable', status: response.status } as const)
                        : ({ kind: 'problem', status: response.status, problem } as const);
                },
            );
            return call ?? { kind: 'unavailable', status: null };
        },
        async heartbeat(engineId, rawBody, signature, signal) {
            const call = await send(
                heartbeatPath(engineId),
                { headers: { [HEARTBEAT_SIGNATURE_HEADER]: signature }, body: rawBody },
                signal,
                async (response) => {
                    if (response.ok) {
                        await response.body?.cancel();
                        return { kind: 'accepted', status: response.status } as const;
                    }
                    return { kind: 'refused', status: response.status, problem: await readProblem(response) } as const;
                },
            );
            return call ?? { kind: 'unavailable' };
        },
    };
}
