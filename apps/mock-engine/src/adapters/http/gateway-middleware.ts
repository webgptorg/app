import type { ClientInfo } from '@ptbk/engine-api';
import { ENGINE_API_PREFIX, MAX_USER_AGENT_LENGTH, SIGN_IN_PATH, createProblem } from '@ptbk/engine-api';
import type { Actor } from '@ptbk/engine-api/in-memory';

import type { SessionStore } from '../../domain/gateway/sessions';
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_COOKIE_NAME } from '../../domain/gateway/sessions';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);
/** Base64url of 16 bytes. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** What the gateway reads from a request; the HTTP app supplies it from the TLS connection and the headers. */
export interface GatewayRequest {
    readonly method: string;
    readonly path: string;
    /** The SNI the TLS certificate was chosen for. */
    readonly hostname: string;
    readonly header: (name: string) => string | undefined;
    readonly clientIp: string;
}

export type GatewayOutcome =
    { readonly kind: 'signed-in'; readonly actor: Actor } | { readonly kind: 'refused'; readonly response: Response };

/**
 * Cross-site request forgery stops here, before anything else runs: a state-changing request must come from this
 * origin (`Origin` equal to `https://` plus a `Host` naming the SNI hostname) with Fetch Metadata saying so
 * (`Sec-Fetch-Site` `same-origin`, or `none` for a user's own navigation). There is no CORS, so nothing else may pass.
 */
export function isSameOriginMutation(request: Omit<GatewayRequest, 'clientIp' | 'path'>): boolean {
    if (SAFE_METHODS.has(request.method)) return true;
    const host = request.header('host')?.toLowerCase();
    const origin = request.header('origin')?.toLowerCase();
    const site = request.header('sec-fetch-site')?.toLowerCase();
    if (host === undefined || origin === undefined || site === undefined) return false;
    const hostname = host.replace(/:\d{1,5}$/, '');
    return hostname === request.hostname.toLowerCase() && origin === `https://${host}` && ALLOWED_FETCH_SITES.has(site);
}

/** The session token from `Cookie`, or `null`; a malformed or repeated cookie is no session. */
export function sessionToken(cookieHeader: string | undefined): string | null {
    if (cookieHeader === undefined) return null;
    const values = cookieHeader
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
        .map((part) => part.slice(SESSION_COOKIE_NAME.length + 1));
    const [token] = values;
    return values.length === 1 && token !== undefined && TOKEN_PATTERN.test(token) ? token : null;
}

/** `__Host-` with `Secure`, `Path=/` and no `Domain`, so the cookie belongs to exactly this origin. */
export function sessionCookie(token: string): string {
    const maxAgeS = String(SESSION_ABSOLUTE_TIMEOUT_MS / 1000);
    return `${SESSION_COOKIE_NAME}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}`;
}

export function clearedSessionCookie(): string {
    return `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function clientInfo(request: Pick<GatewayRequest, 'clientIp' | 'header'>): ClientInfo {
    return {
        ip: request.clientIp,
        userAgent: (request.header('user-agent') ?? '').slice(0, MAX_USER_AGENT_LENGTH),
    };
}

/**
 * Resolves the session cookie to the engine's actor. Without a valid session, API requests get 401 problem+json and
 * everything else (a document) is sent to the sign-in page; a stale cookie is cleared either way.
 */
export function authenticate(sessions: SessionStore, request: GatewayRequest): GatewayOutcome {
    const token = sessionToken(request.header('cookie'));
    if (token !== null) {
        const result = sessions.authenticate(token, clientInfo(request));
        if (result.kind === 'signed-in') return result;
    }
    const headers = new Headers();
    if (request.header('cookie')?.includes(`${SESSION_COOKIE_NAME}=`) === true) {
        headers.set('Set-Cookie', clearedSessionCookie());
    }
    if (request.path === ENGINE_API_PREFIX || request.path.startsWith(`${ENGINE_API_PREFIX}/`)) {
        headers.set('Content-Type', 'application/problem+json');
        return {
            kind: 'refused',
            response: new Response(JSON.stringify(createProblem('unauthenticated')), { status: 401, headers }),
        };
    }
    headers.set('Location', SIGN_IN_PATH);
    return { kind: 'refused', response: new Response(null, { status: 303, headers }) };
}
