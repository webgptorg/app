import type { LinkCode } from '@ptbk/protocol';
import { EngineVersion, Hostname, REGISTRATION_ERROR_CODE } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createFakeClock, settleWithClock } from '../../testing/fake-clock';
import type { RegisterAnswer } from '../../testing/fake-dashboard';
import { createFakeDashboard } from '../../testing/fake-dashboard';
import { createMemoryLogger } from '../../testing/memory-logger';
import { createMemoryRegistrationStore } from '../../testing/memory-registration-store';
import { createSeededRandom } from '../../testing/seeded-random';
import { createTestIdentity } from '../../testing/test-identity';
import type { DashboardApi, RegisterCall } from '../dashboard/dashboard-api';
import type { RegistrationRetry } from './register-with-retry';
import {
    LINK_CODE_LIFETIME_MS,
    REGISTRATION_RETRY_BASE_MS,
    REGISTRATION_RETRY_CAP_MS,
    registerWithRetry,
    registrationRetryDelayMs,
} from './register-with-retry';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const RELAYS = [Hostname.parse('relay-a.ptbk.test')];

function problem(status: number, code: string): RegisterAnswer {
    return { status, body: { type: 'about:blank', title: code, status, code } };
}

async function setup() {
    const clock = createFakeClock(Date.parse('2026-10-26T10:00:00Z'));
    const dashboard = createFakeDashboard({ clock, engineDomain: ENGINE_DOMAIN, relays: RELAYS });
    const store = createMemoryRegistrationStore();
    const logger = createMemoryLogger();
    const retries: RegistrationRetry[] = [];
    const identity = await createTestIdentity();
    /** Calls answered before the dashboard sees anything, in turn; then the dashboard answers. */
    const network: RegisterCall[] = [];
    const api: DashboardApi = {
        register: (request, signal) => {
            const scripted = network.shift();
            return scripted === undefined ? dashboard.api.register(request, signal) : Promise.resolve(scripted);
        },
        heartbeat: (...args) => dashboard.api.heartbeat(...args),
    };
    const run = (linkCode: LinkCode, signal = new AbortController().signal) =>
        registerWithRetry({
            store,
            identity,
            dashboardUrl: 'https://app.ptbk.test',
            engineDomain: ENGINE_DOMAIN,
            api,
            engineVersion: EngineVersion.parse('0.1.0'),
            linkCode,
            logger,
            signal,
            clock,
            random: createSeededRandom(3),
            onRetry: (retry) => retries.push(retry),
        });
    return { clock, dashboard, network, store, logger, retries, run };
}

/** Answers with `answers` in turn, then normally. */
function answerInTurn(dashboard: ReturnType<typeof createFakeDashboard>, answers: RegisterAnswer[]): void {
    dashboard.overrideRegister(() => {
        const next = answers.shift();
        if (answers.length === 0) dashboard.overrideRegister(null);
        return next ?? problem(500, 'internal-error');
    });
}

describe('registrationRetryDelayMs', () => {
    it('doubles from the base up to the cap, never below half of each step', () => {
        const random = createSeededRandom(1);
        for (let attempt = 0; attempt < 40; attempt++) {
            const ceiling = Math.min(REGISTRATION_RETRY_CAP_MS, REGISTRATION_RETRY_BASE_MS * 2 ** attempt);
            const delay = registrationRetryDelayMs(attempt, random);
            expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
            expect(delay).toBeLessThanOrEqual(ceiling);
        }
        expect(registrationRetryDelayMs(0, random)).toBeGreaterThanOrEqual(5_000);
    });
});

describe('registerWithRetry', () => {
    it('retries an unreachable dashboard and a rate limit, then registers with the same code', async () => {
        const { clock, dashboard, network, store, retries, run, logger } = await setup();
        const code = dashboard.issueLinkCode('org-a');
        network.push({ kind: 'unavailable', status: null });
        answerInTurn(dashboard, [problem(429, REGISTRATION_ERROR_CODE.rateLimited)]);
        const outcome = await settleWithClock(run(code), clock);
        expect(outcome.kind).toBe('registered');
        expect(await store.load()).not.toBeNull();
        expect(retries.map(({ reason, attempt }) => [reason, attempt])).toEqual([
            ['no-answer', 1],
            ['rate-limited', 2],
        ]);
        expect(dashboard.registerRequests.map((request) => request.linkCode)).toEqual([code, code]);
        expect(logger.text()).not.toContain(code);
        expect(logger.entries.filter(({ event }) => event === 'registration.retrying')).toHaveLength(2);
    });

    it('gives up with the last reason once the link code cannot be valid any more', async () => {
        const { clock, dashboard, retries, run } = await setup();
        dashboard.unreachable = true;
        const startedMs = clock.nowMs();
        const outcome = await settleWithClock(run(dashboard.issueLinkCode('org-a')), clock);
        expect(outcome).toEqual({ kind: 'unavailable', reason: 'no-answer' });
        expect(clock.nowMs() - startedMs).toBeLessThan(LINK_CODE_LIFETIME_MS);
        const waited = retries.reduce((sum, retry) => sum + retry.delayMs, 0);
        expect(waited).toBe(clock.nowMs() - startedMs);
        expect(Math.max(...retries.map((retry) => retry.delayMs))).toBeLessThanOrEqual(REGISTRATION_RETRY_CAP_MS);
    });

    it('stops at once on a rejection, a plan refusal or a refused answer', async () => {
        for (const code of ['invalid-link-code', 'not-entitled', 'engine-limit', 'bad-signature']) {
            const { dashboard, retries, run } = await setup();
            dashboard.overrideRegister(() => problem(403, code));
            expect(await run(dashboard.issueLinkCode('org-a'))).toEqual({ kind: 'rejected', reason: code });
            expect(retries).toEqual([]);
            expect(dashboard.registerRequests).toHaveLength(1);
        }
    });

    it('stops waiting when aborted', async () => {
        const { clock, dashboard, run } = await setup();
        dashboard.unreachable = true;
        const abort = new AbortController();
        const pending = run(dashboard.issueLinkCode('org-a'), abort.signal);
        await new Promise((resolve) => setImmediate(resolve));
        while (clock.pendingTimers() === 0) await new Promise((resolve) => setImmediate(resolve));
        abort.abort(new Error('stopping'));
        await expect(pending).rejects.toThrow('stopping');
        expect(clock.pendingTimers()).toBe(0);
    });
});
