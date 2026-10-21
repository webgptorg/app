import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { m } from '../../paraglide/messages';
import { Page } from '../shell/page';
import { HeartbeatSection } from './heartbeat-section';
import { SECURITY_REFRESH_MS, securityOverviewQueryOptions } from './security-queries';
import {
    CertificateSection,
    EngineSection,
    HostnamesSection,
    OutboundSection,
    RelaysSection,
    UiBundleSection,
} from './security-sections';
import { TrustPanel } from './trust-panel';
import { UpdatePolicySection } from './update-policy-section';

/**
 * The engine's security claims, as the engine itself reports them (spec, Transparency and verifiability 3): nothing
 * here is reformatted or recomputed, only grouped for reading.
 */
export function SecurityPage() {
    const overview = useQuery({
        ...securityOverviewQueryOptions(useEngineApi()),
        refetchInterval: SECURITY_REFRESH_MS,
        throwOnError: isPageLevelFailure,
    });
    return (
        <Page title={m.security_title()}>
            <TrustPanel overview={overview} />
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <EngineSection query={overview} />
                <UpdatePolicySection query={overview} />
                <UiBundleSection query={overview} />
                <CertificateSection query={overview} />
                <RelaysSection query={overview} />
                <HostnamesSection query={overview} />
                <OutboundSection query={overview} />
                <HeartbeatSection query={overview} />
            </div>
        </Page>
    );
}
