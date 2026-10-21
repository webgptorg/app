import { CodeText, ExternalLink } from '@ptbk/ui';

import { m } from '../../paraglide/messages';

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
        <span className="flex flex-col items-start gap-1">
            {logIndex === null ? null : (
                <span className="flex flex-wrap items-center gap-2">
                    <span>{m.security_log_index()}</span>
                    <CodeText value={String(logIndex)} copyable copyLabel={m.security_copy_log_index()} />
                    <ExternalLink href={rekorSearchUrl(logIndex)}>{m.security_log_search()}</ExternalLink>
                </span>
            )}
            {entryUuid === null ? null : (
                <span className="flex flex-wrap items-center gap-2">
                    <span>{m.security_log_uuid()}</span>
                    <CodeText value={entryUuid} group={4} copyable copyLabel={m.security_copy_log_uuid()} />
                </span>
            )}
        </span>
    );
}
