import { Badge } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { useEnvironment } from '../../api/queries';

/** Makes a non-production deployment obvious at a glance; production shows nothing. */
export function EnvironmentBadge() {
    const environment = useEnvironment();
    if (environment.data === undefined || environment.data.environment === 'production') {
        return null;
    }
    // The org name gives way first: the badge is short, and a hidden environment is the costlier mistake.
    return (
        <Badge tone="warning" className="shrink-0">
            {m.environment_label({ environment: environment.data.environment })}
        </Badge>
    );
}
