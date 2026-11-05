import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';

import { defineFeature } from '../../app/registry/feature';
import type { FeatureRequirement } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

/** Setting the engine up is the owner's: the engine asks, and only who manages its settings answers. */
export const ONBOARDING_REQUIREMENT: FeatureRequirement = {
    capability: KNOWN_CAPABILITIES.onboarding,
    permission: 'settings.manage',
};

/** Engine-driven onboarding: no nav entry, since home links to it while setup is pending. */
export const onboardingFeature = defineFeature({
    id: 'onboarding',
    requires: ONBOARDING_REQUIREMENT,
    commands: [
        {
            id: 'onboarding.open',
            label: m.onboarding_command,
            keywords: () => [m.onboarding_keyword()],
            to: '/onboarding',
        },
    ],
});
