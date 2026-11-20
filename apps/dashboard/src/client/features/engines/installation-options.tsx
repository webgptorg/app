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
    const instructions = (
        <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
                {shell === 'powershell'
                    ? m.engines_new_open_powershell()
                    : shell === 'ubuntu'
                      ? m.engines_new_open_ssh()
                      : m.engines_new_open_terminal()}
            </li>
            <li>{m.engines_new_run_block()}</li>
        </ol>
    );
    function commandPanel(command: string) {
        return (
            <div className="flex flex-col gap-3">
                {instructions}
                <InstallationCopyBlock value={command} />
            </div>
        );
    }
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
                        panel: commandPanel(props.option.commands.posix),
                    },
                    {
                        id: 'powershell',
                        label: 'Windows PowerShell',
                        panel: commandPanel(props.option.commands.powershell),
                    },
                    {
                        id: 'ubuntu',
                        label: 'Ubuntu VPS',
                        panel: (
                            <>
                                <p className="mb-3 text-sm">{m.engines_new_ubuntu()}</p>
                                {commandPanel(props.option.commands.ubuntu)}
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
