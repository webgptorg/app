import type { RouteCallInput, RouteContract } from '../../shared/api/contract';
import type { ApiClient, ApiOutcome } from '../api/api-client';

export interface RecordedCall {
    readonly contract: RouteContract;
    readonly input: unknown;
}

type Answer = ApiOutcome<RouteContract> | ((input: unknown) => ApiOutcome<RouteContract>);

/**
 * An {@link ApiClient} whose answers are scripted per contract: `on` sets a standing answer, `once` queues answers
 * used before it. Calls are recorded with their input; an unscripted contract answers `network-error`.
 */
export interface ScriptedApi extends ApiClient {
    readonly calls: RecordedCall[];
    on<C extends RouteContract>(
        contract: C,
        answer: ApiOutcome<C> | ((input: RouteCallInput<C>) => ApiOutcome<C>),
    ): this;
    once<C extends RouteContract>(contract: C, ...answers: ApiOutcome<C>[]): this;
    callsTo(contract: RouteContract): readonly unknown[];
}

export function createScriptedApi(): ScriptedApi {
    const standing = new Map<RouteContract, Answer>();
    const queued = new Map<RouteContract, ApiOutcome<RouteContract>[]>();
    const calls: RecordedCall[] = [];
    const api: ScriptedApi = {
        calls,
        on(contract, answer) {
            standing.set(contract, answer as Answer);
            return api;
        },
        once(contract, ...answers) {
            queued.set(contract, [...(queued.get(contract) ?? []), ...(answers as ApiOutcome<RouteContract>[])]);
            return api;
        },
        callsTo: (contract) => calls.filter((call) => call.contract === contract).map((call) => call.input),
        call<C extends RouteContract>(contract: C, input: RouteCallInput<C>) {
            calls.push({ contract, input });
            const next = queued.get(contract)?.shift();
            if (next !== undefined) {
                return Promise.resolve(next as ApiOutcome<C>);
            }
            const answer = standing.get(contract);
            const outcome = typeof answer === 'function' ? answer(input) : (answer ?? { kind: 'network-error' });
            return Promise.resolve(outcome as ApiOutcome<C>);
        },
    };
    return api;
}

export function ok<T>(data: T) {
    return { kind: 'ok', data } as const;
}

/** A problem answer; the code is checked against the contract by the real client, so tests may pass any declared one. */
export function problem(
    status: number,
    code: string,
): { readonly kind: 'problem'; readonly status: number; readonly code: never } {
    return { kind: 'problem', status, code: code as never };
}
