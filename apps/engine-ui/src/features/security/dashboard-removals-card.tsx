import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { Skeleton, Switch } from '@ptbk/ui';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { QuerySection } from './query-section';
import { securityKeys } from './security-keys';

const MUTATION_TIMEOUT_MS = 30_000;

/**
 * Whether member revocations signed by the organization's dashboard apply here (ADR 0018). On by default; turning it
 * either way needs a fresh passkey and is logged. Engines without `access-requests@1` and members without
 * `settings.manage` see nothing.
 */
export function DashboardRemovalsCard() {
    const allowed = useAllows({ capability: KNOWN_CAPABILITIES.accessRequests, permission: 'settings.manage' });
    const engineApi = useEngineApi();
    const settings = useQuery({
        ...queryOptions({
            queryKey: securityKeys.settings(),
            queryFn: async ({ signal }) => unwrap(await engineApi.settings.get(signal)),
        }),
        enabled: allowed,
    });
    const save = useStepUpAwareMutation({
        mutationFn: async (enabled: boolean) =>
            unwrap(
                await engineApi.settings.setDashboardRemovals({ enabled }, AbortSignal.timeout(MUTATION_TIMEOUT_MS)),
            ),
        invalidates: [securityKeys.settings()],
        successMessage: ({ enabled }) => (enabled ? m.removals_on() : m.removals_off()),
        errorMessage: () => m.removals_failed(),
    });
    if (!allowed) return null;
    return (
        <QuerySection title={m.removals_title()} query={settings} skeleton={<Skeleton className="h-10 w-full" />}>
            {(current) => (
                <div className="max-w-2xl">
                    <Switch
                        label={m.removals_label()}
                        description={m.removals_hint()}
                        checked={save.isPending ? !current.dashboardRemovals : current.dashboardRemovals === true}
                        disabled={save.isPending || current.dashboardRemovals === null}
                        onChange={(event) => {
                            save.mutate(event.target.checked);
                        }}
                    />
                </div>
            )}
        </QuerySection>
    );
}
