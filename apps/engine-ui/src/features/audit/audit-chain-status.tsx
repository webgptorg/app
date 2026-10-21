import { Banner, Button, Skeleton, useLocale } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { useAuditChainStatus } from './audit-queries';

/** The engine's latest verdict on the hash chain; the UI reports it and never re-verifies (U-07, Risks). */
export function AuditChainStatus() {
    const status = useAuditChainStatus();
    const locale = useLocale();
    if (status.isPending) return <Skeleton shape="block" className="h-20 w-full" />;
    if (status.isError) {
        return (
            <Banner
                tone="warning"
                action={
                    <Button
                        size="sm"
                        loading={status.isFetching}
                        onClick={() => {
                            void status.refetch();
                        }}
                    >
                        {m.audit_retry()}
                    </Button>
                }
            >
                {m.audit_chain_failed()}
            </Banner>
        );
    }
    const at = locale.formatDateTime(new Date(status.data.checkedAt));
    if (status.data.status === 'broken') {
        return (
            <Banner tone="danger" title={m.audit_chain_broken_title()}>
                {m.audit_chain_broken_body({ seq: String(status.data.firstBrokenSeq ?? '?'), at })}
            </Banner>
        );
    }
    return (
        <Banner tone="success" title={m.audit_chain_intact_title()}>
            {m.audit_chain_intact_body({ count: locale.formatNumber(status.data.checkedEntries), at })}
        </Banner>
    );
}
