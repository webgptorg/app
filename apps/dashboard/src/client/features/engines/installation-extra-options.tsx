import { ExternalLink } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import type { InstallationOption } from '../../../shared/engine-installation';
import { InstallationCopyBlock } from './installation-copy-block';

/** The manual download needs a separate PowerShell command to pair after setup. */
export function WindowsInstallerOption(props: {
    readonly option: Extract<InstallationOption, { readonly kind: 'download' }>;
}) {
    const { option } = props;
    return (
        <div className="flex flex-col gap-3">
            <div>
                <ExternalLink href={option.url}>
                    {m.engines_new_download_windows({ version: option.version })}
                </ExternalLink>
            </div>
            <p className="text-sm">{m.engines_new_windows_handoff()}</p>
            <InstallationCopyBlock value={option.afterInstall} />
            <details className="text-sm text-text-muted">
                <summary>{m.engines_new_checksum()}</summary>
                <code className="wrap-anywhere">{option.sha256}</code>
            </details>
        </div>
    );
}
