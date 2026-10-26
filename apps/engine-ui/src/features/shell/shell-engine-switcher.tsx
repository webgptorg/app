import { deriveEngineFingerprint } from '@ptbk/protocol';
import { EngineSwitcher } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { engineInfoQueryOptions } from '../engine/engine-queries';
import { dashboardLinks } from './dashboard-links';

/**
 * engine-ui may only talk to its own engine (`connect-src 'self'`), so the switcher shows the current engine and
 * hands over to the dashboard for the full list; without a linked dashboard it shows the current engine only.
 */
export function ShellEngineSwitcher({ compact }: { readonly compact: boolean }) {
    const { data: engine } = useSuspenseQuery(engineInfoQueryOptions(useEngineApi()));
    const links = dashboardLinks(engine.dashboardUrl);
    return (
        <EngineSwitcher
            current={{
                name: engine.name,
                fingerprint: engine.engineId === null ? null : deriveEngineFingerprint(engine.engineId),
                hostname: engine.hostname,
            }}
            engines={[]}
            allEnginesHref={links.allEngines}
            addEngineHref={links.addEngine}
            compact={compact}
        />
    );
}
