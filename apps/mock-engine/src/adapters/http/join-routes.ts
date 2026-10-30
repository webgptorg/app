import { JOIN_OPTIONS_PATH, JOIN_PATH, JOIN_PROBLEM, JOIN_STATUS_PATH, JOIN_VERIFY_PATH } from '@ptbk/engine-api';
import { SIGNED_MEMBER_MESSAGE_MAX_LENGTH } from '@ptbk/protocol';
import { z } from 'zod';

import type { JoinGateway, TicketRefusal } from '../../domain/gateway/join-gateway';
import { clientInfo, sessionCookie } from './gateway-middleware';
import type { Route } from './route';
import { defineHttpRoute } from './route';

export interface JoinRouteDeps {
    readonly join: JoinGateway;
    /** Renders `join.html` for the hostname the browser reached. */
    readonly page: (input: { readonly hostname: string; readonly acceptLanguage: string | undefined }) => Response;
}

const NO_QUERY = z.strictObject({});
const PAGE_HEADERS = z.strictObject({ 'accept-language': z.string().max(1024).optional() });
const CEREMONY_HEADERS = z.strictObject({ host: z.string().max(260), 'user-agent': z.string().max(4096).optional() });
/** Bad, forged and expired tickets get their answers from the gateway, so the schema checks only the size. */
const TICKET = z.string().max(SIGNED_MEMBER_MESSAGE_MAX_LENGTH);
const REQUEST_TOKEN = z.string().max(64);
const CEREMONY_BODY_MAX_BYTES = 32 * 1024;
/** Under the page's 15 s request timeout, so a held status answer always arrives. */
const STATUS_HOLD_MS = 10_000;
const SMALL_BODY_MAX_BYTES = 4 * 1024;

function problem(status: number, code: string): Response {
    return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), {
        status,
        headers: { 'Content-Type': 'application/problem+json' },
    });
}

const REFUSALS: Readonly<Record<TicketRefusal, () => Response>> = {
    invalid: () => problem(403, JOIN_PROBLEM.ticketInvalid),
    expired: () => problem(403, JOIN_PROBLEM.ticketExpired),
    used: () => problem(409, JOIN_PROBLEM.ticketUsed),
    'already-member': () => problem(409, JOIN_PROBLEM.alreadyMember),
    full: () => problem(409, JOIN_PROBLEM.tooManyRequests),
};

/**
 * The join page (ADR 0018) and its endpoints: options and verify carry the dashboard's ticket, read from the URL
 * fragment by the page and posted, never in a query string; status is polled with the opaque token verify returned.
 * Rate-limited like sign-in, as gateway.md asks.
 */
export function createJoinRoutes(deps: JoinRouteDeps): readonly Route[] {
    return [
        defineHttpRoute({
            transport: 'http',
            method: 'GET',
            path: JOIN_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: PAGE_HEADERS,
            body: null,
            handle: ({ connection, headers }) =>
                deps.page({ hostname: connection.hostname, acceptLanguage: headers['accept-language'] }),
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: JOIN_OPTIONS_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: CEREMONY_HEADERS,
            body: { kind: 'json', schema: z.strictObject({ ticket: TICKET }), maxBytes: SMALL_BODY_MAX_BYTES },
            handle: async ({ body, headers, connection }) => {
                const outcome = await deps.join.options({
                    ticket: body.ticket,
                    rp: { id: connection.hostname, origin: `https://${headers.host}` },
                });
                return outcome.kind === 'options'
                    ? Response.json({ options: outcome.options })
                    : REFUSALS[outcome.kind]();
            },
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: JOIN_VERIFY_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: CEREMONY_HEADERS,
            body: {
                kind: 'json',
                schema: z.strictObject({ ticket: TICKET, response: z.unknown() }),
                maxBytes: CEREMONY_BODY_MAX_BYTES,
            },
            handle: async ({ body, headers, connection }) => {
                const outcome = await deps.join.complete({
                    ticket: body.ticket,
                    response: body.response,
                    rp: { id: connection.hostname, origin: `https://${headers.host}` },
                });
                if (outcome.kind === 'waiting') {
                    return Response.json({ code: outcome.code, request: outcome.request }, { status: 201 });
                }
                return outcome.kind === 'not-verified'
                    ? problem(400, JOIN_PROBLEM.passkeyNotVerified)
                    : REFUSALS[outcome.kind]();
            },
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: JOIN_STATUS_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: CEREMONY_HEADERS,
            body: { kind: 'json', schema: z.strictObject({ request: REQUEST_TOKEN }), maxBytes: SMALL_BODY_MAX_BYTES },
            handle: async ({ body, headers, clientIp, signal }) => {
                const status = await deps.join.status({
                    request: body.request,
                    holdMs: STATUS_HOLD_MS,
                    signal,
                    client: clientInfo({
                        clientIp,
                        header: (name) => (name === 'user-agent' ? headers['user-agent'] : undefined),
                    }),
                });
                switch (status.kind) {
                    case 'approved':
                        return Response.json(
                            { state: 'approved', next: '/' },
                            { headers: { 'Set-Cookie': sessionCookie(status.token) } },
                        );
                    case 'unknown':
                        return problem(404, JOIN_PROBLEM.requestUnknown);
                    case 'waiting':
                    case 'declined':
                        return Response.json({ state: status.kind });
                }
            },
        }),
    ];
}
