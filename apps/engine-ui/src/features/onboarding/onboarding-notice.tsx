import { Banner } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { ONBOARDING_REQUIREMENT } from './onboarding-feature';
import { onboardingQueryOptions } from './onboarding-queries';

/** Home's way back into setup while the engine still waits for it, e.g. after "Skip for now". */
export function OnboardingNotice() {
    const allowed = useAllows(ONBOARDING_REQUIREMENT);
    const state = useQuery({ ...onboardingQueryOptions(useEngineApi()), enabled: allowed });
    if (!allowed || state.data === undefined || state.data.status === 'completed') return null;
    return (
        <Banner
            tone="info"
            title={m.onboarding_notice_title()}
            action={
                <ButtonLink to="/onboarding" size="sm">
                    {m.onboarding_notice_action()}
                </ButtonLink>
            }
        >
            {m.onboarding_notice_body()}
        </Banner>
    );
}
