import { ENGINE_API_PREFIX, ENGINE_UI_CSP, SIGN_IN_PATH } from '@ptbk/engine-api';

import type { Fetched } from './bounded-get';
import { mediaType } from './bounded-get';
import type { StagingResult } from './types';

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const GATEWAY_FIX =
    'put the gateway in front of everything: an anonymous document request redirects to /auth/sign-in and an anonymous /api/v1 request gets 401 application/problem+json (docs/engine-integration/gateway.md)';
const CSP_FIX =
    'send Content-Security-Policy equal to ENGINE_UI_CSP from @ptbk/engine-api, byte for byte and once, on every response; the engine sets it, never the UI bundle';
export const SETUP_PATH = '/setup';

export type Answered = Extract<Fetched, { kind: 'response' }>;

/** A served HTML page, or why not. */
export function checkPage(
    id: 'staging.gateway.sign-in' | 'staging.gateway.setup',
    path: string,
    fetched: Fetched,
    fix: string,
): StagingResult {
    if (fetched.kind === 'failed') return { id, status: 'fail', detail: `GET ${path}: ${fetched.reason}`, fix };
    if (fetched.status !== 200) {
        const location = fetched.headers.get('location');
        const to = location === null ? '' : ` to ${location}`;
        return { id, status: 'fail', detail: `GET ${path} answered ${String(fetched.status)}${to}, not 200`, fix };
    }
    const type = mediaType(fetched);
    if (type !== 'text/html') {
        return { id, status: 'fail', detail: `GET ${path} answered 200 ${type ?? 'without a Content-Type'}`, fix };
    }
    return { id, status: 'pass', detail: `GET ${path}: 200 text/html` };
}

export const SIGN_IN_FIX = `serve the gateway's sign-in page at ${SIGN_IN_PATH} to anonymous visitors (docs/engine-integration/gateway.md)`;
export const SETUP_FIX = `serve the setup page at ${SETUP_PATH} to anonymous visitors, before and after the owner's passkey is registered (the reference gateway keeps serving it and says the owner is set up)`;

/** An anonymous visitor reaches nothing but the gateway: documents go to sign-in, the API answers 401. */
export function checkAnonymous(origin: URL, document: Fetched, api: Fetched): StagingResult {
    const id = 'staging.gateway.anonymous';
    const problems: string[] = [];
    if (document.kind === 'failed') problems.push(`GET /: ${document.reason}`);
    else {
        const location = document.headers.get('location');
        const target = location === null ? null : new URL(location, origin);
        if (!REDIRECTS.has(document.status) || target === null) {
            problems.push(`GET / answered ${String(document.status)}, not a redirect to ${SIGN_IN_PATH}`);
        } else if (target.origin !== origin.origin || target.pathname !== SIGN_IN_PATH) {
            problems.push(`GET / redirected to ${target.href}, not ${SIGN_IN_PATH}`);
        }
    }
    const apiPath = `${ENGINE_API_PREFIX}/engine`;
    if (api.kind === 'failed') problems.push(`GET ${apiPath}: ${api.reason}`);
    else if (api.status !== 401 || mediaType(api) !== 'application/problem+json') {
        problems.push(
            `GET ${apiPath} answered ${String(api.status)} ${mediaType(api) ?? 'without a Content-Type'}, not 401 application/problem+json`,
        );
    }
    if (problems.length > 0) return { id, status: 'fail', detail: problems.join('; '), fix: GATEWAY_FIX };
    return {
        id,
        status: 'pass',
        detail: `GET / redirects to ${SIGN_IN_PATH}; GET ${apiPath} answers 401 problem+json`,
    };
}

/** The policy on the pages this check sees: the sign-in page always, the app's entry page with a session. */
export function checkCsp(signIn: Fetched, signedInRoot: Fetched | null): StagingResult {
    const id = 'staging.headers.csp';
    const seen: { readonly label: string; readonly response: Answered }[] = [];
    if (signIn.kind === 'response') seen.push({ label: `GET ${SIGN_IN_PATH}`, response: signIn });
    if (signedInRoot?.kind === 'response') seen.push({ label: 'GET / (signed in)', response: signedInRoot });
    if (seen.length === 0) {
        return {
            id,
            status: 'skip',
            detail: 'no page answered to read the header from',
            fix: 'fix staging.gateway.sign-in first',
        };
    }
    const problems = seen.flatMap(({ label, response }) => {
        const policy = response.headers.get('content-security-policy');
        if (policy === null) return [`${label} sends no Content-Security-Policy`];
        return policy === ENGINE_UI_CSP
            ? []
            : [`${label} sends a Content-Security-Policy other than ENGINE_UI_CSP: ${policy}`];
    });
    if (problems.length > 0) return { id, status: 'fail', detail: problems.join('; '), fix: CSP_FIX };
    const unchecked = signedInRoot === null ? '; GET / not checked without a session' : '';
    return {
        id,
        status: 'pass',
        detail: `${seen.map(({ label }) => label).join(' and ')} send ENGINE_UI_CSP byte for byte${unchecked}`,
    };
}
