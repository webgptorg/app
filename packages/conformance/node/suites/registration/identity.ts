import { Findings } from '../../../src/index';
import type { PlatformCheck } from '../../harness/platform';
import { attemptWait, startLinkedEngine } from '../support';
import { SUITE } from './request';

/** Until the restart's first beat, or the start timeout plus one interval when the engine is slow to beat. */
function restartWindow(ctx: Parameters<PlatformCheck['run']>[0]): number {
    return ctx.expectations.startTimeoutMs + ctx.expectations.heartbeatIntervalMs;
}

export const engineIdDerived: PlatformCheck = {
    id: 'registration.identity.engine-id-derived',
    suite: SUITE,
    title: 'After registering, the engine heartbeats as deriveEngineId(enginePublicKey), in the path and the body',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs,
    async run(ctx) {
        const linked = await startLinkedEngine(ctx);
        const registered = await attemptWait(ctx, linked, 'register', () =>
            linked.dashboard.registrations.find((entry) => entry.answer.status === 200),
        );
        if (!registered.ok) return { kind: 'fail', detail: registered.reason };
        const beat = await attemptWait(
            ctx,
            linked,
            'send a heartbeat',
            () => linked.dashboard.heartbeats.at(0),
            restartWindow(ctx),
        );
        if (!beat.ok) return { kind: 'fail', detail: beat.reason };
        const findings = new Findings();
        const engineId = registered.value.engineId;
        if (beat.value.pathEngineId !== engineId) {
            findings.add('the heartbeat path names another engine ID than the one the public key derives');
        }
        let bodyId: unknown;
        try {
            bodyId = (JSON.parse(beat.value.rawBody.toString('utf8')) as { engineId?: unknown }).engineId;
        } catch {
            bodyId = undefined;
        }
        if (bodyId !== engineId) findings.add("the heartbeat body's engineId is not the one the public key derives");
        return findings.outcome();
    },
};

export const stableAcrossRestarts: PlatformCheck = {
    id: 'registration.identity.stable-across-restarts',
    suite: SUITE,
    title: 'After a restart the engine keeps its key and engine ID: no new key is registered, and it heartbeats as before',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 3 + expectations.heartbeatIntervalMs * 2,
    async run(ctx) {
        const linked = await startLinkedEngine(ctx);
        const first = await attemptWait(
            ctx,
            linked,
            'send a heartbeat',
            () => linked.dashboard.heartbeats.find((beat) => beat.verification?.kind === 'accepted'),
            restartWindow(ctx),
        );
        if (!first.ok) return { kind: 'fail', detail: first.reason };
        const keys = new Set(linked.dashboard.registrations.map((entry) => entry.request?.enginePublicKey));
        const restartedAt = Date.now();
        await linked.engine.restart();
        const after = await attemptWait(
            ctx,
            linked,
            'send a heartbeat after the restart',
            () => linked.dashboard.heartbeats.find((beat) => beat.at >= restartedAt),
            restartWindow(ctx),
        );
        const findings = new Findings();
        const newKeys = linked.dashboard.registrations
            .filter((entry) => entry.at >= restartedAt && !keys.has(entry.request?.enginePublicKey))
            .map((entry) => entry.request?.enginePublicKey);
        if (newKeys.length > 0) findings.add('after the restart the engine registered another public key');
        if (!after.ok) findings.add(after.reason);
        else if (after.value.pathEngineId !== first.value.pathEngineId) {
            findings.add('after the restart the engine heartbeats under another engine ID');
        } else if (after.value.verification?.kind !== 'accepted') {
            findings.add(
                `the first heartbeat after the restart is ${after.value.verification?.kind ?? 'for an unknown engine'}, not accepted`,
            );
        }
        return findings.outcome();
    },
};

export const linkCodeUsedOnce: PlatformCheck = {
    id: 'registration.link-code.used-once',
    suite: SUITE,
    title: 'Restarted with the same environment, the engine uses its stored registration and never sends the link code again',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 3 + expectations.heartbeatIntervalMs * 2,
    async run(ctx) {
        const linked = await startLinkedEngine(ctx);
        const first = await attemptWait(
            ctx,
            linked,
            'send an accepted heartbeat',
            () => linked.dashboard.heartbeats.find((beat) => beat.verification?.kind === 'accepted'),
            restartWindow(ctx),
        );
        if (!first.ok) return { kind: 'fail', detail: first.reason };
        const restartedAt = Date.now();
        await linked.engine.restart();
        const after = await attemptWait(
            ctx,
            linked,
            'send an accepted heartbeat after the restart',
            () => linked.dashboard.heartbeats.find((beat) => beat.at >= restartedAt && beat.answer.status < 300),
            restartWindow(ctx),
        );
        const findings = new Findings();
        const uses = linked.dashboard.registrations.filter(
            (entry) => entry.request?.linkCode === linked.linkCode,
        ).length;
        if (uses !== 1) findings.add(`the link code was sent ${String(uses)} times, not once`);
        if (!after.ok) findings.add(after.reason);
        return findings.outcome();
    },
};
