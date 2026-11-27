import { CopyButton } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { InstallationCode } from './installation-code';

/** Copy feedback belongs to the displayed payload, including when the OS or AI target changes. */
export function InstallationCopyBlock(props: { readonly value: string; readonly prompt?: boolean }) {
    return (
        <div className="overflow-hidden rounded-control border border-hairline bg-(--code-text-bg) text-(--code-text-text)">
            <div className="flex justify-end px-2 pt-2">
                <CopyButton
                    key={props.value}
                    value={props.value}
                    label={props.prompt ? m.engines_new_copy_prompt() : m.engines_new_copy()}
                    variant="secondary"
                    showLabel
                />
            </div>
            <pre className="max-h-96 overflow-auto px-3 pt-1 pb-3 font-mono text-sm wrap-anywhere whitespace-pre-wrap">
                <InstallationCode value={props.value} prompt={props.prompt ?? false} />
            </pre>
        </div>
    );
}
