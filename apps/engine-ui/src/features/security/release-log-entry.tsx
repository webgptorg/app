import { CopyButton } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { ExternalChip, HashValue } from './security-parts';

/** Sigstore's public Rekor search: anyone can look the entry up there without trusting the engine or us. */
export function rekorSearchUrl(logIndex: number): string {
    return `https://search.sigstore.dev/?logIndex=${String(logIndex)}`;
}

export interface ReleaseLogEntryProps {
    readonly logIndex: number | null;
    readonly entryUuid: string | null;
}

/** A release's Rekor entry as the engine reports it: index and UUID, both copyable, and a public lookup. */
export function ReleaseLogEntry({ logIndex, entryUuid }: ReleaseLogEntryProps) {
    if (logIndex === null && entryUuid === null)
        return <span className="text-text-muted">{m.security_log_none()}</span>;
    return (
        <span className="flex min-w-0 flex-col items-start gap-1.5">
            {logIndex === null ? null : (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-text-muted">{m.security_log_index()}</span>
                    <span className="inline-flex items-center gap-0.5">
                        <code className="font-mono text-xs tabular-nums">{String(logIndex)}</code>
                        <CopyButton value={String(logIndex)} label={m.security_copy_log_index()} />
                    </span>
                    <ExternalChip href={rekorSearchUrl(logIndex)}>{m.security_log_search()}</ExternalChip>
                </span>
            )}
            {entryUuid === null ? null : (
                <span className="flex w-full min-w-0 items-center gap-2">
                    <span className="shrink-0 text-text-muted">{m.security_log_uuid()}</span>
                    <HashValue value={entryUuid} copyLabel={m.security_copy_log_uuid()} />
                </span>
            )}
        </span>
    );
}
