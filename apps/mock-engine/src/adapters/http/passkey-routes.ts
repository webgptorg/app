import { SIGN_IN_PATH, STEP_UP_PATH } from '@ptbk/engine-api';
import type { GatewayAsset, GatewayPage } from '@ptbk/gateway-pages';
import {
    GATEWAY_ASSETS,
    GATEWAY_ASSET_PATH,
    isSafeNextPath,
    pickGatewayLanguage,
    renderGatewayPage,
} from '@ptbk/gateway-pages';
import type { EngineId } from '@ptbk/protocol';
import { deriveEngineFingerprint } from '@ptbk/protocol';
import { z } from 'zod';

import type { JoinGateway } from '../../domain/gateway/join-gateway';
import type { RelyingParty } from '../../domain/gateway/passkey-ceremonies';
import type { PasskeyGateway } from '../../domain/gateway/passkey-gateway';
import type { SecureConnection } from '../tls-stream-server';
import type { GatewayPageFiles } from './gateway-page-files';
import { clientInfo, sessionCookie } from './gateway-middleware';
import { createJoinRoutes } from './join-routes';
import type { Route } from './route';
import { defineHttpRoute } from './route';

export const SETUP_PATH = '/setup';
export const SETUP_OPTIONS_PATH = '/setup/options';
export const SETUP_VERIFY_PATH = '/setup/verify';
export const SIGN_IN_OPTIONS_PATH = `${SIGN_IN_PATH}/options`;
export const SIGN_IN_VERIFY_PATH = `${SIGN_IN_PATH}/verify`;
export const STEP_UP_OPTIONS_PATH = `${STEP_UP_PATH}/options`;
export const STEP_UP_VERIFY_PATH = `${STEP_UP_PATH}/verify`;

export interface PasskeyRouteDeps {
    readonly engineId: EngineId;
    readonly gateway: PasskeyGateway;
    readonly files: GatewayPageFiles;
    /** Read per request: the pages say whether the engine has an owner. */
    readonly ownerSetUp: () => boolean;
    /** The engine's CLI name in the pages' recovery hints. */
    readonly command: string;
    /** With dev login the dev pages keep `SIGN_IN_PATH` and `STEP_UP_PATH`; the passkey endpoints stay. */
    readonly devLogin: boolean;
    /** Teams (ADR 0018): the join page and its endpoints. */
    readonly join?: JoinGateway;
}

const NO_QUERY = z.strictObject({});
const PAGE_HEADERS = z.strictObject({ 'accept-language': z.string().max(1024).optional() });
const CEREMONY_HEADERS = z.strictObject({ host: z.string().max(260), 'user-agent': z.string().max(4096).optional() });
const NEXT = z.string().max(2048);
/**
 * The step-up page's query: where to return, and in popup mode the opener's nonce, which the page echoes back when it
 * signals the confirmation (`@ptbk/gateway-pages`).
 */
export const STEP_UP_PAGE_QUERY = z.strictObject({
    returnTo: NEXT.optional(),
    mode: z.literal('popup').optional(),
    nonce: z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,64}$/)
        .optional(),
});
/** WebAuthn responses are a few KiB; the cap leaves room for large attestation objects. */
const CEREMONY_BODY_MAX_BYTES = 32 * 1024;
const SMALL_BODY_MAX_BYTES = 1024;
/** Wrong, malformed and expired secrets get one answer, so the schema checks only the size. */
const SECRET = z.string().max(64);
const ASSET = z.enum(Object.keys(GATEWAY_ASSETS) as [GatewayAsset, ...GatewayAsset[]]);

/** The gateway's own problems; each maps to one state of the pages, and none says more than that state needs. */
function problem(status: number, code: string): Response {
    return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), {
        status,
        headers: { 'Content-Type': 'application/problem+json' },
    });
}

const SETUP_LINK_INVALID = (): Response => problem(403, 'setup-link-invalid');
const OWNER_EXISTS = (): Response => problem(409, 'owner-exists');
const NOT_RECOGNISED = (): Response => problem(401, 'passkey-not-recognised');

/**
 * The relying party is the hostname the browser reached (the SNI), at the origin it used: the gateway has already
 * refused any state-changing request whose `Origin` is not `https://<Host>` with `Host` naming that hostname.
 */
function relyingParty(connection: SecureConnection, host: string): RelyingParty {
    return { id: connection.hostname, origin: `https://${host}` };
}

function fingerprintCells(engineId: EngineId): string {
    return deriveEngineFingerprint(engineId)
        .cells.flat()
        .map((filled) => (filled ? '1' : '0'))
        .join('');
}

/** The ceremony's result as the pages expect it: where to go next, and the session cookie. */
function signedIn(token: string, next: string): Response {
    return Response.json({ next }, { headers: { 'Set-Cookie': sessionCookie(token) } });
}

function nextOrHome(next: string | undefined): string {
    return next !== undefined && isSafeNextPath(next) ? next : '/';
}

/**
 * The reference gateway pages (`@ptbk/gateway-pages`, MIT) and the WebAuthn endpoints behind them: `/setup` with the
 * setup secret from the URL fragment, usernameless sign-in, and step-up. Pages are filled in with values that are
 * public anyway (engine ID, address, fingerprint, whether there is an owner). The secret arrives only in the body of
 * a same-origin POST; in a query string it is an unknown parameter, refused before anything reads it.
 */
export function createPasskeyRoutes(deps: PasskeyRouteDeps): readonly Route[] {
    const fingerprint = deriveEngineFingerprint(deps.engineId).formatted;
    const cells = fingerprintCells(deps.engineId);

    function page(name: GatewayPage, connection: SecureConnection, acceptLanguage: string | undefined): Response {
        return pageFor(name, connection.hostname, acceptLanguage);
    }

    function pageFor(name: GatewayPage, hostname: string, acceptLanguage: string | undefined): Response {
        const html = renderGatewayPage(deps.files.pages[name], {
            lang: pickGatewayLanguage(acceptLanguage ?? null),
            engineId: deps.engineId,
            hostname,
            fingerprint,
            fingerprintCells: cells,
            command: deps.command,
            owner: deps.ownerSetUp() ? 'set' : 'none',
        });
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    const routes: Route[] = [
        defineHttpRoute({
            transport: 'http',
            method: 'GET',
            path: SETUP_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: PAGE_HEADERS,
            body: null,
            handle: ({ connection, headers }) => page('setup.html', connection, headers['accept-language']),
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'GET',
            path: `${GATEWAY_ASSET_PATH as '/auth/assets/'}{name}`,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: z.strictObject({ name: ASSET }),
            query: NO_QUERY,
            headers: null,
            body: null,
            handle: ({ params }) => {
                const asset = deps.files.assets.get(params.name);
                if (asset === undefined) return problem(404, 'not-found');
                return new Response(asset.bytes, { headers: { 'Content-Type': asset.type } });
            },
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: SETUP_OPTIONS_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'setup-ip',
            params: null,
            query: NO_QUERY,
            headers: CEREMONY_HEADERS,
            body: { kind: 'json', schema: z.strictObject({ secret: SECRET }), maxBytes: SMALL_BODY_MAX_BYTES },
            handle: async ({ body, headers, connection }) => {
                const outcome = await deps.gateway.setupOptions({
                    secret: body.secret,
                    rp: relyingParty(connection, headers.host),
                });
                switch (outcome.kind) {
                    case 'options':
                        return Response.json({ options: outcome.options });
                    case 'invalid':
                        return SETUP_LINK_INVALID();
                    case 'owner-exists':
                        return OWNER_EXISTS();
                }
            },
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: SETUP_VERIFY_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'setup-ip',
            params: null,
            query: NO_QUERY,
            headers: CEREMONY_HEADERS,
            body: {
                kind: 'json',
                schema: z.strictObject({ secret: SECRET, response: z.unknown() }),
                maxBytes: CEREMONY_BODY_MAX_BYTES,
            },
            handle: async ({ body, headers, connection, clientIp }) => {
                const outcome = await deps.gateway.completeSetup({
                    secret: body.secret,
                    response: body.response,
                    rp: relyingParty(connection, headers.host),
                    client: clientInfo({
                        clientIp,
                        header: (name) => (name === 'user-agent' ? headers['user-agent'] : undefined),
                    }),
                });
                switch (outcome.kind) {
                    case 'owner':
                        return signedIn(outcome.token, '/');
                    case 'invalid':
                        return SETUP_LINK_INVALID();
                    case 'owner-exists':
                        return OWNER_EXISTS();
                    case 'not-verified':
                        return problem(400, 'passkey-not-verified');
                }
            },
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: SIGN_IN_OPTIONS_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: CEREMONY_HEADERS,
            body: { kind: 'json', schema: z.strictObject({}), maxBytes: SMALL_BODY_MAX_BYTES },
            handle: async ({ headers, connection }) =>
                Response.json({ options: await deps.gateway.signInOptions(relyingParty(connection, headers.host)) }),
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: SIGN_IN_VERIFY_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: CEREMONY_HEADERS,
            body: {
                kind: 'json',
                schema: z.strictObject({ response: z.unknown(), next: NEXT.optional() }),
                maxBytes: CEREMONY_BODY_MAX_BYTES,
            },
            handle: async ({ body, headers, connection, clientIp }) => {
                // Someone approved since their join page closed has their passkey put in place here.
                await deps.join?.settle();
                const outcome = await deps.gateway.signIn({
                    response: body.response,
                    rp: relyingParty(connection, headers.host),
                    client: clientInfo({
                        clientIp,
                        header: (name) => (name === 'user-agent' ? headers['user-agent'] : undefined),
                    }),
                });
                return outcome.kind === 'verified' ? signedIn(outcome.token, nextOrHome(body.next)) : NOT_RECOGNISED();
            },
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: STEP_UP_OPTIONS_PATH,
            auth: 'session',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: CEREMONY_HEADERS,
            body: { kind: 'json', schema: z.strictObject({}), maxBytes: SMALL_BODY_MAX_BYTES },
            handle: async ({ actor, headers, connection }) =>
                Response.json({
                    options: await deps.gateway.stepUpOptions({ actor, rp: relyingParty(connection, headers.host) }),
                }),
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'POST',
            path: STEP_UP_VERIFY_PATH,
            auth: 'session',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: NO_QUERY,
            headers: CEREMONY_HEADERS,
            body: {
                kind: 'json',
                schema: z.strictObject({ response: z.unknown(), next: NEXT.optional() }),
                maxBytes: CEREMONY_BODY_MAX_BYTES,
            },
            handle: async ({ actor, body, headers, connection }) => {
                const confirmed = await deps.gateway.stepUp({
                    actor,
                    response: body.response,
                    rp: relyingParty(connection, headers.host),
                });
                return confirmed ? Response.json({ next: nextOrHome(body.next) }) : NOT_RECOGNISED();
            },
        }),
    ];
    if (deps.join !== undefined) {
        routes.push(
            ...createJoinRoutes({
                join: deps.join,
                page: ({ hostname, acceptLanguage }) => pageFor('join.html', hostname, acceptLanguage),
            }),
        );
    }
    if (deps.devLogin) return routes;
    routes.push(
        defineHttpRoute({
            transport: 'http',
            method: 'GET',
            path: SIGN_IN_PATH,
            auth: 'public',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: z.strictObject({ next: NEXT.optional() }),
            headers: PAGE_HEADERS,
            body: null,
            handle: ({ connection, headers }) => page('sign-in.html', connection, headers['accept-language']),
        }),
        defineHttpRoute({
            transport: 'http',
            method: 'GET',
            path: STEP_UP_PATH,
            auth: 'session',
            permission: null,
            rateLimit: 'gateway-ip',
            params: null,
            query: STEP_UP_PAGE_QUERY,
            headers: PAGE_HEADERS,
            body: null,
            handle: ({ connection, headers }) => page('step-up.html', connection, headers['accept-language']),
        }),
    );
    return routes;
}
