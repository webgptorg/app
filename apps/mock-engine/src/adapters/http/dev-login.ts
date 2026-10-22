import type { Member } from '@ptbk/engine-api';
import { MemberId, SIGN_IN_PATH, SIGN_OUT_PATH, STEP_UP_PATH } from '@ptbk/engine-api';
import { z } from 'zod';

import type { SessionStore } from '../../domain/gateway/sessions';
import { clearedSessionCookie, clientInfo, sessionCookie } from './gateway-middleware';
import type { Route } from './route';
import { defineHttpRoute } from './route';
import { problemResponse } from './route-handler';

export interface GatewayRouteDeps {
    readonly sessions: SessionStore;
    /** Members as the engine lists them now, for the dev sign-in page. */
    readonly members: () => readonly Member[];
    /** `MOCK_DEV_LOGIN=enabled`: anyone who reaches the page can sign in as any member. Never in production. */
    readonly devLogin: boolean;
}

const NO_QUERY = z.strictObject({});
const FORM_MAX_BYTES = 1024;
const ROLE_ORDER = ['owner', 'admin', 'member', 'viewer'] as const;

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

/**
 * No inline script or style: the page renders under the engine's CSP like everything else here. Its forms post as
 * navigations, for which browsers send `Origin: null` under the engine's `Referrer-Policy: no-referrer`, and the
 * gateway refuses a mutation without its own origin. The meta element relaxes only this document's policy, to
 * `same-origin`, so the headers stay the engine's own and no referrer ever leaves the origin.
 */
function page(title: string, body: string): Response {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="same-origin">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Promptbook mock engine</title>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function redirect(location: string, cookie?: string): Response {
    const headers = new Headers({ Location: location });
    if (cookie !== undefined) headers.set('Set-Cookie', cookie);
    return new Response(null, { status: 303, headers });
}

function signInPage(members: readonly Member[]): Response {
    const active = members
        .filter(({ status }) => status === 'active')
        .sort(
            (a, b) =>
                ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.displayName.localeCompare(b.displayName),
        );
    const items = active
        .map(
            (member) => `<li><form method="post" action="${SIGN_IN_PATH}">
<input type="hidden" name="memberId" value="${escapeHtml(member.id)}">
<button type="submit">${escapeHtml(member.displayName)}</button> <span>${escapeHtml(member.role)}</span>
</form></li>`,
        )
        .join('\n');
    return page(
        'Sign in',
        `<p>Development sign-in: choose a member. The real engine signs in with a passkey.</p>\n<ul>\n${items}\n</ul>`,
    );
}

/**
 * The gateway's own pages, standing in for the engine's passkey sign-in and step-up ceremonies (which the mock does
 * not implement). Sign-out always exists; the forms that create or refresh sessions exist only with dev login.
 */
export function createGatewayRoutes(deps: GatewayRouteDeps): readonly Route[] {
    const routes: Route[] = [
        defineHttpRoute({
            transport: 'http',
            method: 'GET',
            path: SIGN_IN_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: null,
            body: null,
            handle: () =>
                deps.devLogin
                    ? signInPage(deps.members())
                    : page(
                          'Sign in',
                          '<p>Development sign-in is disabled. Sessions come from the control listener.</p>',
                      ),
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: SIGN_OUT_PATH,
            auth: 'session',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: null,
            body: null,
            handle: ({ actor }) => {
                deps.sessions.signOut(actor.sessionId);
                return redirect(SIGN_IN_PATH, clearedSessionCookie());
            },
        }),
    ];
    if (!deps.devLogin) return routes;
    routes.push(
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: SIGN_IN_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: z.strictObject({ 'user-agent': z.string().max(4096).optional() }),
            body: { kind: 'form', schema: z.strictObject({ memberId: MemberId }), maxBytes: FORM_MAX_BYTES },
            handle: ({ body, headers, clientIp }) => {
                const member = deps.members().find(({ id, status }) => id === body.memberId && status === 'active');
                if (member === undefined) {
                    return problemResponse({
                        code: 'validation-failed',
                        extras: { errors: [{ path: 'body.memberId', message: 'No such active member.' }] },
                    });
                }
                const signedIn = deps.sessions.signIn({
                    memberId: member.id,
                    permissions: null,
                    client: clientInfo({ clientIp, header: (name) => (headers as Record<string, string>)[name] }),
                });
                return redirect('/', sessionCookie(signedIn.token));
            },
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'GET',
            path: STEP_UP_PATH,
            auth: 'session',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: null,
            body: null,
            handle: () =>
                page(
                    'Confirm it is you',
                    `<p>Development step-up: the real engine asks for a fresh passkey assertion here.</p>
<form method="post" action="${STEP_UP_PATH}"><button type="submit">Confirm</button></form>`,
                ),
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: STEP_UP_PATH,
            auth: 'session',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: null,
            body: null,
            handle: ({ actor }) => {
                deps.sessions.confirmStepUp(actor.sessionId);
                return redirect('/');
            },
        }),
    );
    return routes;
}
