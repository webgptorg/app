import { Banner, useLocale } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { securityOverviewQueryOptions } from '../security/security-queries';
import { updateNoticeQueryOptions } from './home-queries';

/**
 * `GET /security` says an update is available, or the event stream just announced one. Shown until the engine
 * reports it installed; the security panel has the details and the controls.
 */
export function UpdateBanner() {
    const engineApi = useEngineApi();
    const locale = useLocale();
    const security = useQuery(securityOverviewQueryOptions(engineApi)).data;
    const notice = useQuery(updateNoticeQueryOptions()).data ?? null;
    const fromPanel = security?.update.status === 'available' ? security.update : undefined;
    if (fromPanel === undefined && notice === null) return null;
    const version = fromPanel?.availableVersion ?? notice?.version ?? null;
    const eligibleAt = fromPanel?.eligibleAt ?? null;
    return (
        <Banner
            tone="info"
            title={m.home_update_title()}
            action={
                <Link to="/settings" className="text-sm font-medium">
                    {m.home_update_open()}
                </Link>
            }
        >
            {version === null
                ? m.home_update_body()
                : eligibleAt === null
                  ? m.home_update_version({ version })
                  : m.home_update_version_at({ version, at: locale.formatDateTime(new Date(eligibleAt)) })}
        </Banner>
    );
}
