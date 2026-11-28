import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { Skeleton, Switch } from '@ptbk/ui';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { useStepUpAwareMutation } from '../../app/mutations';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { QuerySection } from '../security/query-section';
import { securityKeys } from '../security/security-keys';

const MUTATION_TIMEOUT_MS = 30_000;
const ATTENTION_ACTION = 'settings.dashboard-attention';
/** The Security checklist row that holds the exact last heartbeat (`verification-card.tsx`). */
export const HEARTBEAT_ROW_HASH = 'security-heartbeat';

function parseEnabled(data: unknown): boolean | undefined {
    return typeof data === 'boolean' ? data : undefined;
}

/**
 * The owner's switch for the heartbeat's `attention` (ADR 0027): while on, the dashboard learns how many unseen items
 * wait per person and kind, never what they are. On by default, off by default in strict mode; turning it either way
 * needs a fresh passkey and is logged. Engines without `notifications@1` and members without `settings.manage` see
 * nothing.
 */
export function DashboardAttentionSection() {
    const allowed = useAllows({ capability: KNOWN_CAPABILITIES.notifications, permission: 'settings.manage' });
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
                await engineApi.settings.setDashboardAttention({ enabled }, AbortSignal.timeout(MUTATION_TIMEOUT_MS)),
            ),
        invalidates: [securityKeys.settings()],
        successMessage: ({ enabled }) => (enabled ? m.attention_on() : m.attention_off()),
        errorMessage: () => m.attention_failed(),
        resumeAs: { action: ATTENTION_ACTION, data: (enabled) => enabled, rerun: parseEnabled },
    });
    if (!allowed) return null;
    return (
        <QuerySection title={m.attention_title()} query={settings} skeleton={<Skeleton className="h-10 w-full" />}>
            {(current) => (
                <div className="flex max-w-2xl flex-col gap-3">
                    <Switch
                        label={m.attention_label()}
                        description={m.attention_hint()}
                        checked={save.isPending ? save.variables : current.dashboardAttention === true}
                        disabled={save.isPending || current.dashboardAttention === null}
                        onChange={(event) => {
                            save.mutate(event.target.checked);
                        }}
                    />
                    <p className="text-sm text-text-muted">
                        {current.dashboardAttention === true ? m.attention_state_on() : m.attention_state_off()}{' '}
                        {m.attention_default()}
                    </p>
                    <p className="text-sm text-text-muted">
                        {m.attention_heartbeat()}{' '}
                        <Link to="/security" hash={HEARTBEAT_ROW_HASH}>
                            {m.attention_heartbeat_link()}
                        </Link>
                    </p>
                </div>
            )}
        </QuerySection>
    );
}
