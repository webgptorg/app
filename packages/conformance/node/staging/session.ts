import type { ReadSecurityOverview } from '@ptbk/engine-api';
import { ENGINE_API_PREFIX, EngineInfo, SecurityOverviewReader, toTolerant } from '@ptbk/engine-api';

import type { Fetched } from './bounded-get';
import { COOKIE_FIX, COOKIE_REFUSED_FIX } from './context';
import type { StagingResult } from './types';

const EngineInfoReader = toTolerant(EngineInfo);
export const ENGINE_PATH = `${ENGINE_API_PREFIX}/engine`;
export const SECURITY_PATH = `${ENGINE_API_PREFIX}/security`;

export type JsonRead<T> =
    { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'problem'; readonly detail: string };

/** The part of a zod schema this needs; the package reaches zod only through the contract packages. */
export interface SafeParser<T> {
    safeParse(
        input: unknown,
    ):
        | { readonly success: true; readonly data: T }
        | { readonly success: false; readonly error: { readonly issues: readonly Issue[] } };
}

interface Issue {
    readonly path: readonly PropertyKey[];
    readonly message: string;
}

/** A 200 JSON answer read tolerantly, as the UI reads it: unknown fields are dropped, known ones must be valid. */
export function readJson<T>(path: string, fetched: Fetched, reader: SafeParser<T>): JsonRead<T> {
    if (fetched.kind === 'failed') return { kind: 'problem', detail: `GET ${path}: ${fetched.reason}` };
    if (fetched.status !== 200) return { kind: 'problem', detail: `GET ${path} answered ${String(fetched.status)}` };
    let json: unknown;
    try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fetched.body));
    } catch {
        return { kind: 'problem', detail: `GET ${path} is not JSON` };
    }
    const parsed = reader.safeParse(json);
    if (parsed.success) return { kind: 'ok', value: parsed.data };
    const [issue] = parsed.error.issues;
    const where = issue === undefined || issue.path.length === 0 ? '' : ` at ${issue.path.map(String).join('.')}`;
    return {
        kind: 'problem',
        detail: `GET ${path} does not match the contract${where}: ${issue?.message ?? 'invalid'}`,
    };
}

export function readSecurity(fetched: Fetched): JsonRead<ReadSecurityOverview> {
    return readJson(SECURITY_PATH, fetched, SecurityOverviewReader);
}

export function isRefusedSession(fetched: Fetched | null): boolean {
    return fetched?.kind === 'response' && fetched.status === 401;
}

/** `GET /engine` with the owner session: the engine says it runs behind the relay, under the name it was reached by. */
export function checkEngineInfo(fetched: Fetched | null, hostname: string, engineId: string): StagingResult {
    const id = 'staging.engine.info';
    if (fetched === null) return { id, status: 'skip', detail: 'needs an owner session', fix: COOKIE_FIX };
    if (isRefusedSession(fetched)) {
        return {
            id,
            status: 'fail',
            detail: `GET ${ENGINE_PATH} answered 401 with the owner cookie`,
            fix: COOKIE_REFUSED_FIX,
        };
    }
    const read = readJson(ENGINE_PATH, fetched, EngineInfoReader);
    const contractFix = `answer GET ${ENGINE_PATH} with EngineInfo from @ptbk/engine-api`;
    if (read.kind === 'problem') return { id, status: 'fail', detail: read.detail, fix: contractFix };
    const info = read.value;
    const problems: string[] = [];
    if (info.mode !== 'tunnel') problems.push(`mode is ${info.mode}, not tunnel`);
    if (info.engineId !== engineId) problems.push(`engineId is ${info.engineId ?? 'null'}, not ${engineId}`);
    if (info.hostname !== hostname) problems.push(`hostname is ${info.hostname}, not ${hostname}`);
    if (problems.length > 0) {
        return {
            id,
            status: 'fail',
            detail: problems.join('; '),
            fix: 'a staging engine is reached through the relay under its default hostname: run it in tunnel mode, linked to the dashboard, and report the engine ID and the hostname the request came in on',
        };
    }
    return { id, status: 'pass', detail: `tunnel mode, engineId ${engineId}, hostname ${hostname}` };
}
