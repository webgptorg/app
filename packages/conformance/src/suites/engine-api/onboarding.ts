import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { OnboardingAnswer, OnboardingPromptKind, OnboardingState } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings } from '../../check';
import { requireCapability } from './capability-support';
import { SUITE, attempt } from './support';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;

/** An answer of some kind other than `kind`; these checks only ever send answers the engine must refuse. */
function answerOtherThan(kind: OnboardingPromptKind): OnboardingAnswer {
    return kind === 'confirm' ? { kind: 'upload', fileIds: [] } : { kind: 'confirm', confirmed: false };
}

function duplicates(values: readonly string[]): string[] {
    return values.filter((value, index) => values.indexOf(value) !== index);
}

function stateFindings(state: OnboardingState, findings: Findings): void {
    if ((state.status === 'pending') !== (state.prompt !== null)) {
        findings.add(`GET /onboarding: status ${state.status} with${state.prompt === null ? 'out' : ''} a prompt`);
    }
    if (state.progress !== null && state.progress.step > state.progress.of) {
        findings.add('GET /onboarding: progress.step is past progress.of');
    }
    if (!state.canDefer && state.deferred) findings.add('GET /onboarding: deferred although it cannot be deferred');
    if (!state.canDefer && state.status === 'completed') {
        findings.add('GET /onboarding: completed but still not deferrable, as if there were no project');
    }
    for (const id of duplicates(state.activity.map(({ id }) => id))) {
        findings.add(`GET /onboarding: activity ${id} is listed twice`);
    }
    for (const item of state.activity) {
        if (item.status === 'failed' && item.detail === null) {
            findings.add(`GET /onboarding: activity ${item.id} failed without saying why`);
        }
        if (item.status === 'running' && state.status === 'completed') {
            findings.add(`GET /onboarding: activity ${item.id} still runs after setup completed`);
        }
    }
    const prompt = state.prompt;
    if (prompt === null) return;
    for (const label of duplicates(prompt.details.map(({ label }) => label))) {
        findings.add(`GET /onboarding: the prompt shows the detail "${label}" twice`);
    }
    for (const id of duplicates(prompt.alternatives.map(({ id }) => id))) {
        findings.add(`GET /onboarding: the prompt offers the alternative ${id} twice`);
    }
    if (prompt.kind === 'choice') {
        const ids = new Set(prompt.choices.map(({ id }) => id));
        if (prompt.initial.some((id) => !ids.has(id))) {
            findings.add('GET /onboarding: a choice prompt preselects a choice it does not offer');
        }
    }
}

// The engine's real setup may be under way, so nothing here answers a prompt for real: each check reads, or sends an
// answer the contract says must be refused without a change. `defer` is sent only where it must change nothing.
export const ONBOARDING_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.onboarding.state',
        suite: SUITE,
        title: 'GET /onboarding has a prompt exactly while pending, consistent progress, activity, details and canDefer',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.onboarding);
            const findings = new Findings();
            const state = await world.owner.ok(R.getOnboarding);
            stateFindings(state, findings);
            if (!state.canDefer) {
                await attempt(findings, async () => {
                    await world.owner.problem(R.deferOnboarding, {}, 'onboarding-not-deferrable');
                });
            } else if (state.deferred) {
                await attempt(findings, async () => {
                    const again = await world.owner.ok(R.deferOnboarding);
                    if (!again.deferred) findings.add('POST /onboarding/defer: deferring again undid the deferral');
                });
            }
            if ((await world.owner.ok(R.getOnboarding)).deferred !== state.deferred) {
                findings.add('POST /onboarding/defer: changed whether the onboarding is deferred');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.onboarding.refusals',
        suite: SUITE,
        title: 'A stale prompt is 409 onboarding-prompt-stale; an answer of another kind or an alternative not offered is 400; none changes anything',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.onboarding);
            const findings = new Findings();
            const before = await world.owner.ok(R.getOnboarding);
            await attempt(findings, async () => {
                await world.owner.problem(
                    R.answerOnboarding,
                    { body: { promptId: 'conformance-stale', action: 'back' } },
                    'onboarding-prompt-stale',
                );
            });
            if (before.prompt !== null) {
                const prompt = before.prompt;
                await attempt(findings, async () => {
                    await world.owner.problem(
                        R.answerOnboarding,
                        { body: { promptId: prompt.id, action: 'answer', answer: answerOtherThan(prompt.kind) } },
                        'validation-failed',
                    );
                });
                const links = prompt.alternatives.filter(({ href }) => href !== null).map(({ id }) => id);
                for (const alternativeId of [`conformance-${ctx.runId}-not-offered`, ...links]) {
                    await attempt(findings, async () => {
                        await world.owner.problem(
                            R.answerOnboarding,
                            { body: { promptId: prompt.id, action: 'alternative', alternativeId } },
                            'validation-failed',
                        );
                    });
                }
            }
            const after = await world.owner.ok(R.getOnboarding);
            if (after.prompt?.id !== before.prompt?.id || after.status !== before.status) {
                findings.add('POST /onboarding/answer: a refused answer moved the onboarding on');
            }
            return findings.outcome();
        },
    },
];
