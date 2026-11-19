import { Skeleton, Tabs } from '@ptbk/ui';
import { lazy, Suspense, useState } from 'react';

import { m } from '../../../paraglide/messages';
import type { InstallationOption } from '../../../shared/engine-installation';
import { InstallationCopyBlock } from './installation-copy-block';

const ExtraInstallationOption = lazy(async () => {
    const module = await import('./installation-extra-options');
    return { default: module.ExtraInstallationOption };
});

function CommandOption(props: { readonly option: Extract<InstallationOption, { readonly kind: 'command' }> }) {
    const [shell, setShell] = useState('posix');
    return (
        <>
            <p className="text-sm">{m.engines_new_prerequisites()}</p>
            <Tabs
                label={m.engines_new_shell()}
                selectedId={shell}
                onSelect={setShell}
                tabs={[
                    {
                        id: 'posix',
                        label: 'macOS / Linux',
                        panel: <InstallationCopyBlock value={props.option.commands.posix} />,
                    },
                    {
                        id: 'powershell',
                        label: 'Windows PowerShell',
                        panel: <InstallationCopyBlock value={props.option.commands.powershell} />,
                    },
                    {
                        id: 'ubuntu',
                        label: 'Ubuntu VPS',
                        panel: (
                            <>
                                <p className="mb-3 text-sm">{m.engines_new_ubuntu()}</p>
                                <InstallationCopyBlock value={props.option.commands.ubuntu} />
                            </>
                        ),
                    },
                ]}
            />
        </>
    );
}

/** Render structured commands, prompts and downloads without parsing any payload as markup. */
export function InstallationOptionPanel(props: { readonly option: InstallationOption }) {
    const { option } = props;
    return (
        <div className="flex flex-col gap-3">
            {option.kind === 'command' ? (
                <CommandOption option={option} />
            ) : (
                <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                    <ExtraInstallationOption option={option} />
                </Suspense>
            )}
            <p className="text-sm">{m.engines_new_next_step()}</p>
            <p className="text-sm text-text-muted">{m.engines_new_computer_access()}</p>
        </div>
    );
}
