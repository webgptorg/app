import { STATUS_TINT_CLASSES } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Compass } from 'lucide-react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { ONBOARDING_REQUIREMENT } from './onboarding-feature';
import { onboardingQueryOptions } from './onboarding-queries';

/**
 * Home's way back into setup while the engine still waits for it, e.g. after "Skip for now". A soft surface like Home's
 * own rows rather than a banner: it is an invitation, not a problem.
 */
export function OnboardingNotice() {
    const allowed = useAllows(ONBOARDING_REQUIREMENT);
    const state = useQuery({ ...onboardingQueryOptions(useEngineApi()), enabled: allowed });
    if (!allowed || state.data === undefined || state.data.status === 'completed') return null;
    return (
        <div
            role="status"
            className={cx('soft-surface flex flex-wrap items-center gap-3 px-4 py-3', STATUS_TINT_CLASSES.info)}
        >
            <Compass aria-hidden className="size-5 shrink-0 self-start text-tint sm:self-center" />
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                <p className="text-sm font-medium">{m.onboarding_notice_title()}</p>
                <p className="text-sm text-text-muted">{m.onboarding_notice_body()}</p>
            </div>
            <ButtonLink to="/onboarding" size="sm" className="shrink-0">
                {m.onboarding_notice_action()}
            </ButtonLink>
        </div>
    );
}
