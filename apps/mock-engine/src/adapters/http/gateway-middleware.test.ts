import { MAX_USER_AGENT_LENGTH } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import type { SessionStore } from '../../domain/gateway/sessions';
import { SESSION_COOKIE_NAME } from '../../domain/gateway/sessions';
import { authenticate, clientInfo, isSameOriginMutation, sessionCookie, sessionToken } from './gateway-middleware';

const TOKEN = 'A'.repeat(21) + '_';
const HOST = 'engine.example.test';

function mutation(headers: Record<string, string>, method = 'POST', hostname = HOST) {
    return isSameOriginMutation({ method, hostname, header: (name) => headers[name] });
}

describe('isSameOriginMutation', () => {
    const same = { host: HOST, origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' };

    it('lets safe methods through without looking', () => {
        for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(mutation({}, method)).toBe(true);
    });

    it('accepts this origin, with a port as the Host carries it, case-insensitively', () => {
        expect(mutation(same)).toBe(true);
        expect(mutation({ ...same, 'sec-fetch-site': 'none' })).toBe(true);
        expect(
            mutation({
                host: `${HOST}:8443`,
                origin: `HTTPS://${HOST.toUpperCase()}:8443`,
                'sec-fetch-site': 'Same-Origin',
            }),
        ).toBe(true);
    });

    it.each([
        ['an Origin with another port', { ...same, origin: `https://${HOST}:8443` }],
        ['plain http', { ...same, origin: `http://${HOST}` }],
        ['a Host other than the SNI', { ...same, host: 'other.example.test', origin: 'https://other.example.test' }],
        ['a same-site request', { ...same, 'sec-fetch-site': 'same-site' }],
        ['no Host', { origin: same.origin, 'sec-fetch-site': 'same-origin' }],
        ['no Origin', { host: HOST, 'sec-fetch-site': 'same-origin' }],
        ['no Fetch Metadata', { host: HOST, origin: same.origin }],
    ])('refuses %s', (_name, headers) => {
        expect(mutation(headers)).toBe(false);
        expect(mutation(headers, 'DELETE')).toBe(false);
    });
});

describe('session cookie', () => {
    it('reads exactly one well-formed token', () => {
        expect(sessionToken(undefined)).toBeNull();
        expect(sessionToken(`${SESSION_COOKIE_NAME}=${TOKEN}`)).toBe(TOKEN);
        expect(sessionToken(`theme=dark; ${SESSION_COOKIE_NAME}=${TOKEN}; lang=cs`)).toBe(TOKEN);
        expect(sessionToken(`${SESSION_COOKIE_NAME}=${TOKEN}; ${SESSION_COOKIE_NAME}=${TOKEN}`)).toBeNull();
        expect(sessionToken(`${SESSION_COOKIE_NAME}=${TOKEN}x`)).toBeNull();
        expect(sessionToken(`${SESSION_COOKIE_NAME}=${'A'.repeat(21)}=`)).toBeNull();
        expect(sessionToken(`ptbk_session=${TOKEN}`)).toBeNull();
    });

    it('is set as a __Host- cookie for the session lifetime', () => {
        expect(sessionCookie(TOKEN)).toBe(
            `${SESSION_COOKIE_NAME}=${TOKEN}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
        );
    });
});

describe('clientInfo', () => {
    it('records the tunnel address and a truncated User-Agent', () => {
        const long = 'x'.repeat(MAX_USER_AGENT_LENGTH + 10);
        expect(clientInfo({ clientIp: '2001:db8::1', header: () => long })).toEqual({
            ip: '2001:db8::1',
            userAgent: 'x'.repeat(MAX_USER_AGENT_LENGTH),
        });
        expect(clientInfo({ clientIp: '192.0.2.1', header: () => undefined }).userAgent).toBe('');
    });
});

describe('authenticate', () => {
    const refusing = { authenticate: () => ({ kind: 'invalid' as const }) } as unknown as SessionStore;
    const request = (path: string, cookie?: string) => ({
        method: 'GET',
        path,
        hostname: HOST,
        clientIp: '192.0.2.1',
        header: (name: string) => (name === 'cookie' ? cookie : undefined),
    });

    it('answers the API with 401 and documents with the sign-in page', async () => {
        const api = authenticate(refusing, request('/api/v1'));
        if (api.kind !== 'refused') throw new Error('expected a refusal');
        expect(api.response.status).toBe(401);
        expect(await api.response.json()).toMatchObject({ code: 'unauthenticated' });
        const page = authenticate(refusing, request('/api/v10'));
        if (page.kind !== 'refused') throw new Error('expected a refusal');
        expect(page.response.status).toBe(303);
        expect(page.response.headers.get('set-cookie')).toBeNull();
    });

    it('clears a cookie that no longer names a session', () => {
        const outcome = authenticate(refusing, request('/api/v1/me', `${SESSION_COOKIE_NAME}=${TOKEN}`));
        if (outcome.kind !== 'refused') throw new Error('expected a refusal');
        expect(outcome.response.headers.get('set-cookie')).toContain('Max-Age=0');
    });
});
