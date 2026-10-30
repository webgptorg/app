import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { AccessCard } from './access-card';
import { DashboardRemovalsCard } from './dashboard-removals-card';
import { SECURITY_REFRESH_MS, securityOverviewQueryOptions } from './security-queries';
import { TrustPanel } from './trust-panel';
import { VerificationCard } from './verification-card';

/**
 * What a member can verify and who can get in. The engine's own claims (`security.read`) are shown as reported: nothing
 * is reformatted or recomputed, only summarised (spec, Transparency and verifiability 3).
 */
export function SecurityPage() {
    const { can } = usePermissions();
    const canVerify = can('security.read');
    const overview = useQuery({
        ...securityOverviewQueryOptions(useEngineApi()),
        enabled: canVerify,
        refetchInterval: SECURITY_REFRESH_MS,
        throwOnError: isPageLevelFailure,
    });
    return (
        <Page title={m.security_title()}>
            <TrustPanel overview={canVerify ? overview : null} />
            {canVerify ? <VerificationCard query={overview} /> : null}
            <AccessCard />
            <DashboardRemovalsCard />
        </Page>
    );
}
