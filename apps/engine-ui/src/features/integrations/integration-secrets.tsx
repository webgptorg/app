import type { ReadIntegration } from '@ptbk/engine-api';
import { Card } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { SecretStateBadge } from './integration-status';

/**
 * The secrets the integration references, by name and state. There is no value here and no way to enter one: the
 * engine sets them itself.
 */
export function IntegrationSecrets({ secretRefs }: { readonly secretRefs: ReadIntegration['secretRefs'] }) {
    const unresolved = secretRefs.some(({ state }) => state !== 'resolved');
    return (
        <Card title={m.integration_secrets_title()} titleLevel={2}>
            {secretRefs.length === 0 ? (
                <p className="text-sm text-text-muted">{m.integration_secrets_none()}</p>
            ) : (
                <div className="flex flex-col gap-3">
                    <ul className="flex flex-col divide-y divide-divider">
                        {secretRefs.map((ref) => (
                            <li key={ref.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                                <span className="break-all">{ref.name}</span>
                                <SecretStateBadge state={ref.state} />
                            </li>
                        ))}
                    </ul>
                    {unresolved ? <p className="text-sm text-text-muted">{m.integration_secrets_fix()}</p> : null}
                </div>
            )}
        </Card>
    );
}
