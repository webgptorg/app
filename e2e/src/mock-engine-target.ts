/*
 * The mock engine as an `EngineTarget`: the only file of the UI flows that knows the mock's dev-only control listener
 * (`/__mock/*`, plain HTTP on the stack network, never mounted in the tunnel). Owner and permission-set sessions come
 * from C-05's mock conformance target, so both suites sign in the same way.
 */
import { createMockEngineTarget } from '@ptbk/conformance';
import type { SessionCredential } from '@ptbk/conformance';

import type {
    EngineTarget,
    FaultPlan,
    LastHeartbeat,
    ResetOptions,
    ScriptedRunInput,
    SessionCookie,
    TamperOutcome,
    UiSessionSubject,
} from './engine-target.ts';

export interface MockEngineTargetOptions {
    readonly hostname: string;
    /** e.g. `http://10.89.231.31:4480`. */
    readonly controlUrl: URL;
    /** The signed release whose archive init changed after signing (`UI_RELEASES.tampered`). */
    readonly tamperedVersion: string;
    readonly fetch?: typeof fetch;
}

const CONTROL_TIMEOUT_MS = 30_000;
/** RFC 6265 token characters, as C-05's target checks them. */
const COOKIE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/;

export class ControlError extends Error {
    constructor(path: string, status: number) {
        super(`the mock control listener answered ${String(status)} to ${path}`);
        this.name = 'ControlError';
    }
}

/** `name=value` from C-05's credential, split back into the cookie the browser context needs. */
export function cookieFromCredential(credential: SessionCredential | null): SessionCookie {
    if (credential === null || !('cookie' in credential)) throw new Error('the mock engine signs in with cookies');
    const separator = credential.cookie.indexOf('=');
    const name = credential.cookie.slice(0, separator);
    const value = credential.cookie.slice(separator + 1);
    if (separator < 1 || !COOKIE_TOKEN.test(name) || !COOKIE_TOKEN.test(value)) {
        throw new Error('the session credential is not one cookie');
    }
    return { name, value };
}

function readString(record: unknown, key: string): string | null {
    if (typeof record !== 'object' || record === null) return null;
    const value = (record as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
}

function readObject(record: unknown, key: string): unknown {
    if (typeof record !== 'object' || record === null) return null;
    return (record as Record<string, unknown>)[key] ?? null;
}

export function createMockEngineUiTarget(options: MockEngineTargetOptions): EngineTarget {
    const doFetch = options.fetch ?? fetch;
    const conformance = createMockEngineTarget({
        baseUrl: new URL(`https://${options.hostname}/`),
        controlUrl: options.controlUrl,
        fetch: doFetch,
    });

    async function control(method: string, path: string, body?: unknown): Promise<unknown> {
        const response = await doFetch(new URL(path, options.controlUrl), {
            method,
            signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
            ...(body === undefined
                ? {}
                : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new ControlError(`${method} ${path}`, response.status);
        }
        return response.status === 204 ? null : response.json();
    }

    async function roleSession(role: string): Promise<SessionCookie> {
        const answer = await control('POST', '/__mock/sessions', { subject: { kind: 'member', role } });
        const cookie = readObject(answer, 'cookie');
        return cookieFromCredential({
            cookie: `${readString(cookie, 'name') ?? ''}=${readString(cookie, 'value') ?? ''}`,
        });
    }

    return {
        hostname: options.hostname,
        async session(subject: UiSessionSubject): Promise<SessionCookie> {
            if (subject.kind === 'member' && 'role' in subject) return roleSession(subject.role);
            return cookieFromCredential(await conformance.session(subject));
        },
        controls: {
            async reset({ scenario, seed, capabilities }: ResetOptions) {
                await control('POST', '/__mock/reset', { scenario, seed, capabilities: [...capabilities] });
            },
            faults: {
                async set(plan: FaultPlan) {
                    await control('PUT', '/__mock/faults', plan);
                },
                async clear() {
                    await control('DELETE', '/__mock/faults');
                },
            },
            async pauseSimulation() {
                await control('POST', '/__mock/simulation', { mode: 'paused' });
            },
            async advanceTime(ms: number) {
                await control('POST', '/__mock/simulation/advance', { ms });
            },
            async scriptRun(input: ScriptedRunInput) {
                const run = await control('POST', '/__mock/runs', input);
                const runId = readString(run, 'id');
                if (runId === null) throw new Error('the scripted run has no ID');
                return { runId };
            },
            async inboundEmail(input) {
                const answer = await control('POST', '/__mock/inbound-email', input);
                return { runId: readString(readObject(answer, 'fire'), 'runId') };
            },
            async tamperBundle(): Promise<TamperOutcome> {
                const answer = await control('POST', '/__mock/ui/check', { pinnedVersion: options.tamperedVersion });
                const outcome = readObject(answer, 'outcome');
                return {
                    refused: readString(outcome, 'kind') === 'refused',
                    reason: readString(outcome, 'reason'),
                    activeVersion: readString(readObject(answer, 'active'), 'version'),
                };
            },
            async lastHeartbeat(): Promise<LastHeartbeat | null> {
                const beat = readObject(await control('GET', '/__mock/heartbeat'), 'lastHeartbeat');
                const sentAt = readString(beat, 'sentAt');
                const body = readString(beat, 'body');
                return sentAt === null || body === null ? null : { sentAt, body };
            },
        },
    };
}
