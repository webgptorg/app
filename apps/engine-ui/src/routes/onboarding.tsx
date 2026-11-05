import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { onboardingQueryOptions } from '../features/onboarding/onboarding-queries';
import { OnboardingPage } from '../features/onboarding/onboarding-page';

export const Route = createFileRoute('/onboarding')({
    beforeLoad: requireFeature('onboarding'),
    loader: ({ context }) => {
        context.queryClient.query(onboardingQueryOptions(context.engineApi)).catch(() => undefined);
    },
    component: OnboardingPage,
});
