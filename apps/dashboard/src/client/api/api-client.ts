import type { RouteCallInput, RouteContract, RouteErrorCode, RouteResponse } from '../../shared/api/contract';
import {
    COMMON_PROBLEM_CODES,
    PROBLEM_CONTENT_TYPE,
    problemSchema,
    type CommonProblemCode,
} from '../../shared/api/problem';
import { parseTolerantly } from './tolerant-parse';

export type ApiOutcome<C extends RouteContract> =
    | { readonly kind: 'ok'; readonly data: RouteResponse<C> }
    | { readonly kind: 'problem'; readonly status: number; readonly code: RouteErrorCode<C> | CommonProblemCode }
    /** The server answered something its contract does not allow: treated as a bug, never as data. */
    | { readonly kind: 'invalid-response'; readonly status: number }
    | { readonly kind: 'network-error' };

export interface ApiClient {
    call<C extends RouteContract>(contract: C, input: RouteCallInput<C>, signal?: AbortSignal): Promise<ApiOutcome<C>>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function buildPath(contract: RouteContract, input: Readonly<Record<string, unknown>>): string {
    const params = (input['params'] ?? {}) as Readonly<Record<string, string>>;
    const path = contract.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
        const value = params[name];
        if (value === undefined) {
            throw new Error(`Missing path parameter ${name} for ${contract.path}`);
        }
        return encodeURIComponent(value);
    });
    const query = Object.entries((input['query'] ?? {}) as Readonly<Partial<Record<string, string>>>).flatMap(
        ([name, value]): [string, string][] => (value === undefined ? [] : [[name, value]]),
    );
    return query.length === 0 ? path : `${path}?${new URLSearchParams(query).toString()}`;
}

async function readJson(
    response: Response,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
    try {
        return { ok: true, value: await response.json() };
    } catch {
        return { ok: false };
    }
}

/** A fetch client over the shared route table: every response is parsed with the contract before anyone sees it. */
export function createApiClient(deps: { readonly fetch: typeof fetch; readonly timeoutMs?: number }): ApiClient {
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return {
        async call<C extends RouteContract>(contract: C, input: RouteCallInput<C>, signal?: AbortSignal) {
            const parts = input as Readonly<Record<string, unknown>>;
            const path = buildPath(contract, parts);
            const timeout = AbortSignal.timeout(timeoutMs);
            let response: Response;
            try {
                response = await deps.fetch(path, {
                    method: contract.method,
                    headers: {
                        Accept: 'application/json',
                        ...(contract.input.body === null ? {} : { 'Content-Type': 'application/json' }),
                    },
                    ...(contract.input.body === null ? {} : { body: JSON.stringify(parts['body']) }),
                    credentials: 'same-origin',
                    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
                });
            } catch {
                return { kind: 'network-error' };
            }
            const body = await readJson(response);
            if (!body.ok) {
                return { kind: 'invalid-response', status: response.status };
            }
            if (response.ok) {
                const data = parseTolerantly(contract.output, body.value);
                return data.success
                    ? { kind: 'ok', data: data.data as RouteResponse<C> }
                    : { kind: 'invalid-response', status: response.status };
            }
            const problem = parseTolerantly(problemSchema, body.value);
            const allowed: readonly string[] = [...COMMON_PROBLEM_CODES, ...contract.errorCodes];
            if (
                !problem.success ||
                problem.data.status !== response.status ||
                !allowed.includes(problem.data.code) ||
                !(response.headers.get('Content-Type') ?? '').startsWith(PROBLEM_CONTENT_TYPE)
            ) {
                return { kind: 'invalid-response', status: response.status };
            }
            return {
                kind: 'problem',
                status: response.status,
                code: problem.data.code as RouteErrorCode<C> | CommonProblemCode,
            };
        },
    };
}
