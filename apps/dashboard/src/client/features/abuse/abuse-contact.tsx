import { Anchor } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { m } from '../../../paraglide/messages';
import { useApiClient } from '../../api/api-client-context';
import { abuseContactQuery } from '../../api/queries';

/** The configured abuse address as a mail link; plain text while it loads or when it cannot be loaded. */
export function AbuseContactLink() {
    const contact = useQuery(abuseContactQuery(useApiClient()));
    if (contact.data !== undefined) {
        return <Anchor href={`mailto:${contact.data}`}>{contact.data}</Anchor>;
    }
    return (
        <span className="text-text-muted">
            {contact.isError ? m.abuse_contact_unavailable() : m.abuse_contact_loading()}
        </span>
    );
}
