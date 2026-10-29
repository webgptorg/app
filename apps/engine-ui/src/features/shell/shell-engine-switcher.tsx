import { deriveEngineFingerprint } from '@ptbk/protocol';
import { EngineSwitcher } from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { engineInfoQueryOptions } from '../engine/engine-queries';
import { securityFeature } from '../security/security-feature';
import { TRUST_PANEL_HASH } from '../security/trust-panel-hash';
import { dashboardLinks } from './dashboard-links';

/**
 * engine-ui may only talk to its own engine (`connect-src 'self'`), so the switcher shows the current engine and
 * hands over to the dashboard for the full list. It is also the shell's one trust mark: "Verify this engine" opens
 * the trust panel, with the fingerprint code to compare against the dashboard's.
 */
export function ShellEngineSwitcher({ compact }: { readonly compact: boolean }) {
    const { data: engine } = useSuspenseQuery(engineInfoQueryOptions(useEngineApi()));
    const navigate = useNavigate();
    const mayVerify = useVisibleFeatures().some((feature) => feature.id === securityFeature.id);
    const links = dashboardLinks(engine.dashboardUrl);
    const fingerprint = engine.engineId === null ? null : deriveEngineFingerprint(engine.engineId);
    const verify: MenuEntry[] = mayVerify
        ? [
              {
                  kind: 'item',
                  id: 'verify',
                  label: m.engine_verify(),
                  ...(fingerprint === null
                      ? {}
                      : { description: m.ui_trust_mark_fingerprint({ code: fingerprint.formatted }) }),
                  icon: <ShieldCheck aria-hidden />,
                  onSelect: () => {
                      void navigate({ to: '/security', hash: TRUST_PANEL_HASH });
                  },
              },
          ]
        : [];
    return (
        <EngineSwitcher
            current={{ name: engine.name, fingerprint, hostname: engine.hostname }}
            engines={[]}
            allEnginesHref={links.allEngines}
            addEngineHref={links.addEngine}
            compact={compact}
            leadingItems={verify}
        />
    );
}
