import type { ReadIntegration } from '@ptbk/engine-api';
import { Section } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { SecretStateBadge } from './integration-status';

/**
 * The secrets the integration references, by name and state; with none, the section is left out. There is no value
 * here and no way to enter one: the engine sets them itself.
 */
export function IntegrationSecrets({ secretRefs }: { readonly secretRefs: ReadIntegration['secretRefs'] }) {
    if (secretRefs.length === 0) return null;
    const unresolved = secretRefs.some(({ state }) => state !== 'resolved');
    return (
        <Section
            title={m.integration_secrets_title()}
            {...(unresolved ? { description: m.integration_secrets_fix() } : {})}
        >
            <ul className="flex flex-col divide-y divide-hairline">
                {secretRefs.map((ref) => (
                    <li key={ref.name} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-2">
                        <span className="min-w-0 font-mono text-xs break-all">{ref.name}</span>
                        <SecretStateBadge state={ref.state} />
                    </li>
                ))}
            </ul>
        </Section>
    );
}
