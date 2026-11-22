import { Banner } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { m } from '../../../paraglide/messages';
import type { LicenseView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { licenseQuery } from '../../api/queries';
import { Link } from '../../core/link';
import { useSession } from '../session/use-session';

const READ_PERMISSION = 'license.read';

const MESSAGES: Readonly<Record<NonNullable<LicenseView['notice']>, () => string>> = {
    unlinked: () => m.license_notice_unlinked(),
    missing: () => m.license_notice_missing(),
    expired: () => m.license_notice_expired(),
    exceeded: () => m.license_notice_exceeded(),
};

/**
 * A quiet line on the engines screen when licences are missing, expired or exceeded. Advisory (ADR 0021): it never
 * blocks anything, and nothing renders while the licence loads, fails or is simply unknown.
 */
export function LicenseNotice() {
    const session = useSession();
    const enabled = session.licensing && session.activeOrg.permissions.includes(READ_PERMISSION);
    const api = useApiClient();
    const license = useQuery({ ...licenseQuery(api), enabled });
    const notice = enabled ? license.data?.notice : null;
    if (notice === null || notice === undefined) {
        return null;
    }
    return (
        <Banner tone="info" action={<Link to="/license">{m.license_notice_action()}</Link>}>
            {MESSAGES[notice]()}
        </Banner>
    );
}
