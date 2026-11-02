import type { RegisterEngineResponse } from '@ptbk/protocol';
import { REGISTER_RESPONSE_MAX_BYTES } from '@ptbk/protocol';

import { Findings } from '../../../src/index';
import type { PlatformCheck, PlatformCheckContext } from '../../harness/platform';
import { attemptWait, quietly, startLinkedEngine } from '../support';
import { SUITE } from './request';

function acceptedWindow(ctx: PlatformCheckContext): number {
    return ctx.expectations.startTimeoutMs + ctx.expectations.heartbeatIntervalMs;
}

export const unknownFieldsIgnored: PlatformCheck = {
    id: 'registration.response.unknown-fields-ignored',
    suite: SUITE,
    title: 'A registration answer with fields a later version added is accepted (read tolerantly)',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs,
    async run(ctx) {
        const linked = await startLinkedEngine(ctx, {
            decorateRegistration: (response) => ({ ...response, plan: { name: 'later' }, regions: ['eu'] }),
        });
        const accepted = await attemptWait(
            ctx,
            linked,
            'send an accepted heartbeat after an answer with unknown fields',
            () => linked.dashboard.heartbeats.find((beat) => beat.answer.status < 300),
            acceptedWindow(ctx),
        );
        return accepted.ok ? { kind: 'pass' } : { kind: 'fail', detail: accepted.reason };
    },
};

function otherEngineId(engineId: string): string {
    return `${engineId.slice(0, -1)}${engineId.endsWith('a') ? 'b' : 'a'}`;
}

const INVALID_ANSWERS: readonly {
    readonly name: string;
    readonly decorate: (response: RegisterEngineResponse) => unknown;
}[] = [
    {
        name: 'an engine ID the key does not derive',
        decorate: (response) => {
            const engineId = otherEngineId(response.engineId);
            return { ...response, engineId, hostname: response.hostname.replace(response.engineId, engineId) };
        },
    },
    {
        name: 'a hostname outside the engine domain',
        decorate: (response) => ({ ...response, hostname: `${response.engineId}.elsewhere.localhost` }),
    },
    {
        name: `a body over REGISTER_RESPONSE_MAX_BYTES (${String(REGISTER_RESPONSE_MAX_BYTES)})`,
        decorate: (response) => ({ ...response, padding: 'x'.repeat(REGISTER_RESPONSE_MAX_BYTES) }),
    },
];

export const invalidRefused: PlatformCheck = {
    id: 'registration.response.invalid-refused',
    suite: SUITE,
    title: 'A registration answer with another identity or over the size cap is refused: no heartbeat, nothing stored',
    timeoutMs: (expectations) =>
        INVALID_ANSWERS.length *
        (expectations.startTimeoutMs * 2 + expectations.quietWindowMs + expectations.heartbeatIntervalMs),
    async run(ctx) {
        const findings = new Findings();
        for (const answer of INVALID_ANSWERS) {
            let invalid = true;
            const linked = await startLinkedEngine(ctx, {
                decorateRegistration: (response) => (invalid ? answer.decorate(response) : response),
            });
            const asked = await attemptWait(ctx, linked, 'send a registration request', () =>
                linked.dashboard.registrations.at(0),
            );
            if (!asked.ok) {
                findings.add(`${answer.name}: ${asked.reason}`);
                continue;
            }
            await quietly(ctx.expectations.quietWindowMs, ctx.signal);
            if (linked.dashboard.heartbeats.length > 0) findings.add(`${answer.name}: the engine sent heartbeats`);
            await linked.engine.stop();
            invalid = false;
            const restartedAt = Date.now();
            await linked.engine.restart({ PTBK_LINK_CODE: linked.dashboard.issueLinkCode() });
            const again = await attemptWait(
                ctx,
                linked,
                'register again and send an accepted heartbeat',
                () => linked.dashboard.heartbeats.find((beat) => beat.at >= restartedAt && beat.answer.status < 300),
                acceptedWindow(ctx),
            );
            if (!again.ok) findings.add(`${answer.name}, then a valid answer after a restart: ${again.reason}`);
            await linked.engine.stop();
        }
        return findings.outcome();
    },
};
