import { SIGN_IN_PATH, SIGN_OUT_PATH, STEP_UP_PATH } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import type { SessionStore } from '../../domain/gateway/sessions';
import { createGatewayRoutes } from './dev-login';

const sessions = {} as SessionStore;

describe('gateway routes', () => {
    it('offer sign-in and step-up forms only with dev login', () => {
        const keys = (devLogin: boolean) =>
            createGatewayRoutes({ sessions, members: () => [], devLogin })
                .map((route) => `${route.method} ${route.path} ${route.auth}`)
                .sort();
        expect(keys(false)).toEqual([`GET ${SIGN_IN_PATH} public`, `POST ${SIGN_OUT_PATH} session`]);
        expect(keys(true)).toEqual(
            [
                `GET ${SIGN_IN_PATH} public`,
                `GET ${STEP_UP_PATH} session`,
                `POST ${SIGN_IN_PATH} public`,
                `POST ${SIGN_OUT_PATH} session`,
                `POST ${STEP_UP_PATH} session`,
            ].sort(),
        );
    });

    it('declare no permission and the gateway rate limit', () => {
        for (const route of createGatewayRoutes({ sessions, members: () => [], devLogin: true })) {
            expect(route.permission).toBeNull();
            expect(route.rateLimit).toBe('gateway-ip');
        }
    });

    it('let their form posts carry this origin, which the engine-wide no-referrer policy would turn into null', async () => {
        const signIn = createGatewayRoutes({ sessions, members: () => [], devLogin: true }).find(
            (route) => route.method === 'GET' && route.path === SIGN_IN_PATH,
        );
        if (signIn?.transport !== 'http') throw new Error('no sign-in page');
        const response = await signIn.handle({ query: {} } as never);
        expect(await response.text()).toContain('<meta name="referrer" content="same-origin">');
    });

    describe('step-up', () => {
        const NONCE = 'n0nce-from-the-opener_1';
        const confirmed: string[] = [];
        const routes = createGatewayRoutes({
            sessions: { confirmStepUp: (id: string) => confirmed.push(id) } as unknown as SessionStore,
            members: () => [],
            devLogin: true,
        });
        const route = (method: string) => {
            const found = routes.find((candidate) => candidate.method === method && candidate.path === STEP_UP_PATH);
            if (found?.transport !== 'http') throw new Error(`no ${method} step-up route`);
            return found;
        };

        it('accepts the popup query and keeps it on the form it posts', async () => {
            const query = { mode: 'popup', nonce: NONCE, returnTo: '/wallet' };
            expect(route('GET').query.safeParse(query).success).toBe(true);
            expect(route('GET').query.safeParse({ ...query, nonce: 'short' }).success).toBe(false);
            const response = await route('GET').handle({ query } as never);
            expect(await response.text()).toContain(
                `action="${STEP_UP_PATH}?mode=popup&#38;nonce=${NONCE}&#38;returnTo=%2Fwallet"`,
            );
        });

        it('answers a popup with the page that signals the opener, and anyone else with a redirect back', async () => {
            const popup = await route('POST').handle({
                actor: { sessionId: 'session-1' },
                query: { mode: 'popup', nonce: NONCE },
            } as never);
            const html = await popup.text();
            expect(html).toContain('data-page="step-up-confirmed"');
            expect(html).toContain('<script type="module" src="/auth/assets/gateway.js"></script>');
            expect(html).not.toMatch(/<script>|\son[a-z]+=|\sstyle=/);

            const page = await route('POST').handle({
                actor: { sessionId: 'session-2' },
                query: { returnTo: '/wallet' },
            } as never);
            expect(page.headers.get('Location')).toBe('/wallet');
            expect(confirmed).toEqual(['session-1', 'session-2']);
        });
    });
});
