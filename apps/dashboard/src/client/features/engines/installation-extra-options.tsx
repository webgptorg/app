import { ExternalLink, Tabs, useLocale } from '@ptbk/ui';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import type { InstallationOption } from '../../../shared/engine-installation';
import { InstallationCopyBlock } from './installation-copy-block';

function AiOption(props: { readonly option: Extract<InstallationOption, { readonly kind: 'ai' }> }) {
    const { locale } = useLocale();
    const [target, setTarget] = useState('local');
    const prompts = props.option.prompts[locale.startsWith('cs') ? 'cs' : 'en'];
    return (
        <>
            <p className="text-sm">{m.engines_new_ai_hint()}</p>
            <Tabs
                label={m.engines_new_ai_target()}
                selectedId={target}
                onSelect={setTarget}
                tabs={[
                    {
                        id: 'local',
                        label: m.engines_new_ai_local(),
                        panel: <InstallationCopyBlock label={m.engines_new_copy_prompt()} value={prompts.local} />,
                    },
                    {
                        id: 'server',
                        label: m.engines_new_ai_server(),
                        panel: <InstallationCopyBlock label={m.engines_new_copy_prompt()} value={prompts.server} />,
                    },
                ]}
            />
        </>
    );
}

/** AI and download UI loads only after the user selects one of those optional paths. */
export function ExtraInstallationOption(props: {
    readonly option: Exclude<InstallationOption, { readonly kind: 'command' }>;
}) {
    const { option } = props;
    if (option.kind === 'ai') return <AiOption option={option} />;
    return (
        <>
            <ExternalLink href={option.url}>{m.engines_new_download_windows({ version: option.version })}</ExternalLink>
            <p className="text-sm">{m.engines_new_windows_handoff()}</p>
            <InstallationCopyBlock value={option.afterInstall} />
            <details className="text-sm text-text-muted">
                <summary>{m.engines_new_checksum()}</summary>
                <code className="wrap-anywhere">{option.sha256}</code>
            </details>
        </>
    );
}
