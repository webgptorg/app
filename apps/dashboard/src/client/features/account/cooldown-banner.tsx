import { Banner, useLocale as useFormatters } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';

/**
 * After a recovery, sensitive actions (removing engines, changing custom hostnames or billing ownership) are blocked
 * for 72 hours (docs/security.md); this says until when, and what to do if the recovery was not theirs.
 */
export function CooldownBanner(props: { readonly endsAt: number | null; readonly now: number }) {
    const formatters = useFormatters();
    if (props.endsAt === null || props.endsAt <= props.now) {
        return null;
    }
    return (
        <Banner tone="warning" title={m.cooldown_title()}>
            {m.cooldown_body({ until: formatters.formatDateTime(new Date(props.endsAt)) })}
        </Banner>
    );
}
