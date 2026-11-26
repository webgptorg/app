import { Skeleton, type TabDefinition } from '@ptbk/ui';
import { lazy, Suspense } from 'react';

import { m } from '../../../paraglide/messages';
import type { InstallationOption } from '../../../shared/engine-installation';
import { InstallationCopyBlock } from './installation-copy-block';

const WindowsInstallerOption = lazy(async () => ({
    default: (await import('./installation-extra-options')).WindowsInstallerOption,
}));

/** Keep the three terminal commands together at the start, and the AI prompt for a server last. */
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
                        panel: (
                            <div className="flex flex-col gap-2">
                                <InstallationCopyBlock value={option.commands.ubuntu} />
                                <p className="text-sm text-text-muted">{m.engines_new_ubuntu()}</p>
                            </div>
                        ),
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
