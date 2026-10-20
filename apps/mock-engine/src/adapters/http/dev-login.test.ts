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
});
