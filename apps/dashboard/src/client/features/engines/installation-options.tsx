import { Skeleton, type TabDefinition } from '@ptbk/ui';
import { lazy, Suspense } from 'react';

import { m } from '../../../paraglide/messages';
import type { InstallationOption } from '../../../shared/engine-installation';
import { InstallationCopyBlock } from './installation-copy-block';

const WindowsInstallerOption = lazy(async () => ({
    default: (await import('./installation-extra-options')).WindowsInstallerOption,
}));

/**
 * The three one-line commands come first and together, so the server command stays in view on a narrow page where the
 * tab list scrolls; then AI, the EXE, configured paths and the AI prompt for a server.
 */
export function installationTabs(
    options: readonly InstallationOption[],
    configuredTabs: readonly TabDefinition[],
    locale: string,
): TabDefinition[] {
    const local: TabDefinition[] = [];
    const remote: TabDefinition[] = [];
    for (const option of options) {
        switch (option.kind) {
            case 'command':
                local.push(
                    {
                        id: 'posix',
                        label: 'macOS / Linux',
                        panel: <InstallationCopyBlock value={option.commands.posix} />,
                    },
                    {
                        id: 'powershell',
                        label: 'Windows PowerShell',
                        panel: <InstallationCopyBlock value={option.commands.powershell} />,
                    },
                    {
                        id: 'ubuntu',
                        label: 'Ubuntu VPS',
                        panel: <InstallationCopyBlock value={option.commands.ubuntu} />,
                    },
                );
                break;
            case 'ai': {
                const prompts = option.prompts[locale.startsWith('cs') ? 'cs' : 'en'];
                local.push({
                    id: 'ai',
                    label: m.engines_new_tab_ai(),
                    panel: <InstallationCopyBlock prompt value={prompts.local} />,
                });
                remote.push({
                    id: 'ai-server',
                    label: m.engines_new_ai_server(),
                    panel: <InstallationCopyBlock prompt value={prompts.server} />,
                });
                break;
            }
            case 'download':
                local.push({
                    id: option.id,
                    label: 'Windows EXE',
                    panel: (
                        <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                            <WindowsInstallerOption option={option} />
                        </Suspense>
                    ),
                });
                break;
        }
    }
    return [...local, ...configuredTabs, ...remote];
}
