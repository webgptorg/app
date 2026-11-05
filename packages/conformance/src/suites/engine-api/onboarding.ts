import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { OnboardingAnswer, OnboardingPromptKind } from '@ptbk/engine-api';

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

// The engine's real setup may be under way, so nothing here answers a prompt for real: each check reads, or sends an
// answer the contract says must be refused without a change.
export const ONBOARDING_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.onboarding.state',
        suite: SUITE,
        title: 'GET /onboarding has a prompt exactly while pending, and its progress is within its steps',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.onboarding);
            const findings = new Findings();
            const state = await world.owner.ok(R.getOnboarding);
            if ((state.status === 'pending') !== (state.prompt !== null)) {
                findings.add(
                    `GET /onboarding: status ${state.status} with${state.prompt === null ? 'out' : ''} a prompt`,
                );
            }
            if (state.progress !== null && state.progress.step > state.progress.of) {
                findings.add('GET /onboarding: progress.step is past progress.of');
            }
            if (state.prompt?.kind === 'choice') {
                const ids = new Set(state.prompt.choices.map(({ id }) => id));
                if (state.prompt.initial.some((id) => !ids.has(id))) {
                    findings.add('GET /onboarding: a choice prompt preselects a choice it does not offer');
                }
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.onboarding.refusals',
        suite: SUITE,
        title: 'An answer to a stale prompt is 409 onboarding-prompt-stale, one of another kind 400, and neither changes anything',
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
            }
            const after = await world.owner.ok(R.getOnboarding);
            if (after.prompt?.id !== before.prompt?.id || after.status !== before.status) {
                findings.add('POST /onboarding/answer: a refused answer moved the onboarding on');
            }
            return findings.outcome();
        },
    },
];
