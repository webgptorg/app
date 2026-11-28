import { StatusPill } from '@ptbk/ui';

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
        <StatusPill tone="warning" className="shrink-0">
            {/* A phone shows the environment's name alone, so the org name keeps room to be read. */}
            <span aria-hidden="true" className="sm:hidden">
                {environment.data.environment}
            </span>
            <span className="max-sm:sr-only">{m.environment_label({ environment: environment.data.environment })}</span>
        </StatusPill>
    );
}
