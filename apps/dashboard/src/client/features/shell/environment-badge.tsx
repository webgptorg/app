import { m } from '../../../paraglide/messages';
import { useEnvironment } from '../../api/queries';

/** Makes a non-production deployment obvious at a glance; production shows nothing. */
export function EnvironmentBadge() {
    const environment = useEnvironment();
    if (environment.data === undefined || environment.data.environment === 'production') {
        return null;
    }
    return (
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            {m.environment_label({ environment: environment.data.environment })}
        </span>
    );
}
