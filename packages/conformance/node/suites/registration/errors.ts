import { Findings } from '../../../src/index';
import { problemAnswer } from '../../fakes/dashboard';
import type { PlatformCheck } from '../../harness/platform';
import { attemptWait, quietly, startLinkedEngine } from '../support';
import { SUITE } from './request';

/** A retrying engine waits at least 5 s before its first retry and backs off, so a window sees at most three. */
const MAX_RETRYABLE_ATTEMPTS = 3;

interface RegistrationError {
    /** Declared as a literal, like every check ID, so the guide's checklist script finds it. */
    readonly id: string;
    readonly code: string;
    readonly status: number;
    /** Whether the guide lets the engine try again later. */
    readonly retryable: boolean;
    readonly title: string;
}

function errorCheck(error: RegistrationError): PlatformCheck {
    return {
        id: error.id,
        suite: SUITE,
        title: error.title,
        timeoutMs: (expectations) =>
            expectations.startTimeoutMs * 3 + expectations.quietWindowMs + expectations.heartbeatIntervalMs,
        async run(ctx) {
            let refusing = true;
            const linked = await startLinkedEngine(ctx, {
                onRegister: () => (refusing ? problemAnswer(error.status, error.code) : undefined),
            });
            const asked = await attemptWait(ctx, linked, 'send a registration request', () =>
                linked.dashboard.registrations.at(0),
            );
            if (!asked.ok) return { kind: 'fail', detail: asked.reason };
            await quietly(ctx.expectations.quietWindowMs, ctx.signal);
            const findings = new Findings();
            const attempts = linked.dashboard.registrations.length;
            const seconds = (ctx.expectations.quietWindowMs / 1000).toFixed(0);
            if (!error.retryable && attempts > 1) {
                findings.add(
                    `the engine sent ${String(attempts)} registration requests within ${seconds} s; ${error.code} is final`,
                );
            }
            if (error.retryable && attempts > MAX_RETRYABLE_ATTEMPTS) {
                findings.add(
                    `the engine sent ${String(attempts)} registration requests within ${seconds} s: a retry loop`,
                );
            }
            if (linked.dashboard.heartbeats.length > 0)
                findings.add('the engine sent heartbeats without a registration');
            if (!linked.engine.logs().includes(error.code)) {
                findings.add(
                    `the engine output does not name the problem code ${error.code}, so its operator cannot tell what to do`,
                );
            }
            refusing = false;
            const restartedAt = Date.now();
            await linked.engine.restart();
            const after = await attemptWait(
                ctx,
                linked,
                'register after a restart once the dashboard accepts',
                () => linked.dashboard.heartbeats.find((beat) => beat.at >= restartedAt && beat.answer.status === 204),
                ctx.expectations.startTimeoutMs + ctx.expectations.heartbeatIntervalMs,
            );
            if (!after.ok) findings.add(`${after.reason}; a refused registration must leave nothing stored`);
            return findings.outcome();
        },
    };
}

export const ERROR_CHECKS: readonly PlatformCheck[] = [
    errorCheck({
        id: 'registration.errors.invalid-link-code',
        code: 'invalid-link-code',
        status: 401,
        retryable: false,
        title: '401 invalid-link-code: no retry, the output names the code, nothing stored',
    }),
    errorCheck({
        id: 'registration.errors.engine-exists',
        code: 'engine-exists',
        status: 409,
        retryable: false,
        title: '409 engine-exists: no retry, the output names the code, nothing stored',
    }),
    errorCheck({
        id: 'registration.errors.engine-suspended',
        code: 'engine-suspended',
        status: 403,
        retryable: false,
        title: '403 engine-suspended: no retry, the output names the code, nothing stored',
    }),
    errorCheck({
        id: 'registration.errors.not-entitled',
        code: 'not-entitled',
        status: 403,
        retryable: false,
        title: '403 not-entitled: no retry, the output names the code, nothing stored',
    }),
    errorCheck({
        id: 'registration.errors.rate-limited',
        code: 'rate-limited',
        status: 429,
        retryable: true,
        title: '429 rate-limited: at most a slow retry, the output names the code, nothing stored',
    }),
    errorCheck({
        id: 'registration.errors.unavailable',
        code: 'unavailable',
        status: 503,
        retryable: true,
        title: '503 unavailable: at most a slow retry, the output names the code, nothing stored',
    }),
];
