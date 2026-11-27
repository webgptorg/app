import { Banner } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { m } from '../../../paraglide/messages';
import type { LicenseView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { licenseQuery } from '../../api/queries';
import { Link } from '../../core/link';
import { useLicenseReadable } from './license-notice';

type CheckPoint = keyof LicenseView['checks'];

const CHECK_MESSAGES: Readonly<Record<CheckPoint, () => string>> = {
    engineLink: () => m.license_check_engine_link(),
    memberInvite: () => m.license_check_member_invite(),
};

/**
 * Before linking an engine or inviting people: one calm line when the licence would not cover it. Advisory mode only
 * warns here; with enforcement the server answers the action itself, so a denial is never shown twice.
 */
export function LicenseCheckNotice(props: { readonly point: CheckPoint; readonly withLink?: boolean }) {
    const enabled = useLicenseReadable();
    const api = useApiClient();
    const license = useQuery({ ...licenseQuery(api), enabled });
    const check = enabled ? license.data?.checks[props.point] : undefined;
    if (check?.outcome !== 'warn') {
        return null;
    }
    return (
        <Banner
            tone="info"
            {...(props.withLink === false ? {} : { action: <Link to="/license">{m.license_notice_action()}</Link> })}
        >
            {CHECK_MESSAGES[props.point]()}
        </Banner>
    );
}
