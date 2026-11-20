import { CopyButton } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';

/** Copy feedback belongs to the displayed payload, including when the OS or AI target changes. */
export function InstallationCopyBlock(props: { readonly value: string; readonly label?: string }) {
    return (
        <div className="overflow-hidden rounded-control border border-hairline bg-(--code-text-bg) text-(--code-text-text)">
            <div className="flex justify-end px-2 pt-2">
                <CopyButton
                    key={props.value}
                    value={props.value}
                    label={props.label ?? m.engines_new_copy()}
                    variant="secondary"
                    showLabel
                />
            </div>
            <pre className="max-h-96 overflow-auto px-3 pt-1 pb-3 font-mono text-sm wrap-anywhere whitespace-pre-wrap">
                <code>{props.value}</code>
            </pre>
        </div>
    );
}
