import { Badge } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { useEnvironment } from '../../api/queries';

/** Makes a non-production deployment obvious at a glance; production shows nothing. */
export function EnvironmentBadge() {
    const environment = useEnvironment();
    if (environment.data === undefined || environment.data.environment === 'production') {
        return null;
    }
    return <Badge tone="warning">{m.environment_label({ environment: environment.data.environment })}</Badge>;
}
